// One SSH agent per eligible session: a socket that signs only for the session's live
// grants (ssh-agent-socket.js) and the files that let plain OpenSSH reach them
// (ssh-session-config.js). The agent's generation and socket token live in the session
// record (`sshAgent`), so a restart listens again at the same path and a reload's new
// generation retires the old one. Launch wiring (env, sandbox grants) is the caller's:
// `launchDetails(id)` names the paths and grants it needs.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { SyncQueue } from "../../lib/sync-queue.js";
import { privateFile } from "../memory/memory-validation.js";
import { createAgentAudit } from "./ssh-agent-audit.js";
import { agentHosts } from "./ssh-agent-policy.js";
import {
  agentSocketLocation,
  newAgentToken,
  SessionAgentSocket,
} from "./ssh-agent-socket.js";
import { supportsSessionBind } from "./ssh-openssh-version.js";
import {
  readSessionAliases,
  resolveOpenSshBinaries,
  sessionAliases,
  sessionFolder,
  writeSessionFiles,
} from "./ssh-session-config.js";

// The session's generated ssh_config and its agent socket, for hints and fallbacks.
export const SSH_CONFIG_ENV = "AGENTPIER_SSH_CONFIG";
export const SSH_AGENT_SOCK_ENV = "AGENTPIER_SSH_AUTH_SOCK";

const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const generationPattern = /^[0-9a-f-]{36}$/;
const tokenPattern = /^[0-9a-f]{32}$/;
const keyIdPattern = /^[0-9a-f-]{36}$/;
const codingTools = new Set(["codex", "claude", "opencode"]);
const maxIdentity = 65536;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Whether a launch or a session record gets an agent. Shell sessions do unless they
 * are login sessions; Codex, Claude Code and OpenCode only with the SSH tools. Login,
 * pipeline and agent (assistant) sessions never do.
 */
export function agentEligible({ tool, purpose, pipeline, sshTools } = {}) {
  if (purpose === "login" || pipeline) return false;
  if (tool === "shell") return true;
  return codingTools.has(tool) && sshTools?.enabled === true;
}

function storedAgent(record, id) {
  const agent = record?.id === id ? record.sshAgent : null;
  if (
    agent?.enabled !== true ||
    typeof agent.generation !== "string" ||
    !generationPattern.test(agent.generation) ||
    typeof agent.token !== "string" ||
    !tokenPattern.test(agent.token)
  )
    return null;
  return { generation: agent.generation, token: agent.token };
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Removes `target` below `top` when every folder from `top` down to its parent is a
// real directory. A link at `target` is unlinked, never followed; rmSync does not
// follow links inside it either.
function removeBelow(top, target) {
  const relative = path.relative(top, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw codedError("SSH_FOLDER_UNSAFE", "Unsafe session SSH folder");
  let folder = top;
  for (const part of ["", ...relative.split(path.sep).slice(0, -1)]) {
    folder = path.join(folder, part);
    const stat = lstatOrNull(folder);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw codedError("SSH_FOLDER_UNSAFE", "Unsafe session SSH folder");
  }
  const stat = lstatOrNull(target);
  if (!stat) return;
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

// What a written set of files depends on; equal fingerprints need no rewrite.
function fingerprint(agent, hosts, aliases) {
  return JSON.stringify({
    hosts: hosts.map((host) => [
      host.accessId,
      host.name,
      host.host,
      host.port,
      host.username,
      host.keyId,
      host.publicKey,
      host.hostKey,
      host.legacy,
    ]),
    aliases,
    binaries: agent.binaries,
    socketPath: agent.location.socketPath,
  });
}

export class SessionSshAgents {
  constructor({
    dataDir,
    store,
    grants,
    sessions,
    audit,
    openssh,
    home = os.homedir(),
    log = console,
  }) {
    this.dataDir = path.resolve(dataDir);
    Object.assign(this, { store, grants, sessions, openssh, home, log });
    this.agentAudit = createAgentAudit({ append: (event) => audit?.append(event) });
    this.agents = new Map();
    this.syncs = new SyncQueue();
  }

  get supported() {
    return supportsSessionBind(this.openssh);
  }

  binaries(pathEnv) {
    return resolveOpenSshBinaries(pathEnv ?? process.env.PATH, [
      path.join(this.dataDir, "ssh-agents"),
    ]);
  }

  record(id) {
    try {
      const value = readJSON(path.join(this.dataDir, "sessions", `${id}.json`), null);
      return value && typeof value === "object" && value.id === id ? value : null;
    } catch {
      return null;
    }
  }

  // The record belongs to this listener: running, eligible, same generation.
  current(record, agent) {
    return Boolean(
      record?.id === agent.id &&
      record.status === "running" &&
      agentEligible(record) &&
      record.sshAgent?.enabled === true &&
      record.sshAgent.generation === agent.generation,
    );
  }

  /** The private key of one catalog key, read per signature and never kept. */
  identity(keyId) {
    if (typeof keyId !== "string" || !keyIdPattern.test(keyId))
      throw codedError("SSH_AGENT_KEY_UNSUPPORTED", "Invalid SSH key id");
    return privateFile(path.join(this.dataDir, "ssh", "identities", keyId, "identity"), {
      max: maxIdentity,
    });
  }

  async authorize(agent) {
    if (this.agents.get(agent.id) !== agent) return null;
    const record = this.record(agent.id);
    if (!this.current(record, agent)) return null;
    agent.projectId = record.sshTools?.project?.projectId;
    return { hosts: agentHosts(this.store.list(), await this.grants.effective(record)) };
  }

  async start(id, { token, generation, binaries }) {
    const location = agentSocketLocation(this.dataDir, id, token, {
      home: this.home,
      warn: (code) => this.log.warn("Session SSH agent socket:", code),
    });
    const agent = { id, token, generation, binaries, location, written: null };
    const scope = () => ({ sessionId: id, projectId: agent.projectId });
    agent.socket = new SessionAgentSocket({
      socketPath: location.socketPath,
      root: location.root,
      authorize: () => this.authorize(agent),
      readIdentity: (keyId) => this.identity(keyId),
      onSigned: (host) => this.agentAudit.connected({ ...scope(), host }),
      onDenied: (code) => this.agentAudit.denied({ ...scope(), code }),
    });
    await agent.socket.listen();
    this.agents.set(id, agent);
    return agent;
  }

  /**
   * Starts the session's agent and writes its files; returns the launch with
   * `sshAgent: { enabled, generation, token }`, or the launch unchanged when the
   * session is not eligible, OpenSSH is older than 8.9 or no `ssh` is on PATH. A
   * reload keeps the socket token (same path) and takes a new generation.
   */
  async prepare({ id, account, launch, purpose, pipeline } = {}) {
    const tool = account?.tool;
    if (
      !this.supported ||
      !agentEligible({ tool, purpose, pipeline, sshTools: launch?.sshTools })
    )
      return launch;
    const binaries = this.binaries(launch?.env?.PATH);
    if (!binaries) return launch;
    sessionFolder(this.dataDir, id);
    return this.syncs.run(async () => {
      const record = this.record(id);
      const previous = this.agents.get(id);
      const token = previous?.token ?? storedAgent(record, id)?.token ?? newAgentToken();
      if (previous) {
        this.agents.delete(id);
        await previous.socket.close();
      }
      const generation = randomUUID();
      try {
        const agent = await this.start(id, { token, generation, binaries });
        // Before session creation saves the record: the hosts of the launch project
        // and, on a reload, the assignments kept for the record.
        await this.syncAgent(agent, {
          ...record,
          id,
          tool,
          accountId: account?.id ?? record?.accountId,
          status: "running",
          purpose,
          pipeline,
          sshTools: launch.sshTools,
        });
      } catch (error) {
        await this.teardown(id, token);
        throw error;
      }
      return { ...launch, sshAgent: { enabled: true, generation, token } };
    });
  }

  /** Paths and sandbox grants of a session's agent for its launch, or null. */
  launchDetails(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const folder = sessionFolder(this.dataDir, id);
    const { socketPath } = agent.location;
    return {
      folder,
      configPath: path.join(folder, "ssh_config"),
      binDir: path.join(folder, "bin"),
      socketPath,
      binaries: { ...agent.binaries },
      generation: agent.generation,
      grants: [
        { access: "read", path: folder },
        { access: "socket", path: socketPath },
      ],
    };
  }

  // Any error is a failure: the files go, so the CLI never trusts a partial set, and
  // the next sync writes them again.
  async syncAgent(agent, session) {
    try {
      const hosts = agentHosts(this.store.list(), await this.grants.effective(session));
      const aliases = sessionAliases(hosts, readSessionAliases(this.dataDir, agent.id));
      const written = fingerprint(agent, hosts, aliases);
      const folder = sessionFolder(this.dataDir, agent.id);
      if (written === agent.written && fs.existsSync(path.join(folder, "ssh_config")))
        return "unchanged";
      agent.written = null;
      const { skipped } = writeSessionFiles(folder, {
        hosts,
        aliases,
        socketPath: agent.location.socketPath,
        binaries: agent.binaries,
      });
      if (skipped.length)
        this.log.warn("Session SSH agent skipped hosts:", skipped.join(", "));
      agent.written = written;
      return "written";
    } catch (error) {
      agent.written = null;
      this.remove(() => this.removeSessionFolder(agent.id));
      this.log.error(
        "Session SSH agent files could not be written:",
        error?.code || "error",
      );
      throw error;
    }
  }

  /** Resolves "written" or "unchanged"; syncs run one at a time. */
  sync(session) {
    return this.syncs.run(() => this.syncOnce(session));
  }

  async syncOnce(session) {
    const agent = this.agents.get(session?.id);
    // Only prepare and restore start an agent: a discarded session stays gone.
    if (!agent || !this.current(session, agent)) return "unchanged";
    return this.syncAgent(agent, session);
  }

  /** `syncAll` after the queued syncs; calls while it waits share one pass. */
  refresh() {
    return this.syncs.coalesce(() => this.syncAll());
  }

  /** Every session with an agent; one failing session never stops the others. */
  async syncAll() {
    let sessions = [];
    try {
      sessions = await this.sessions.list();
    } catch {
      return;
    }
    for (const session of sessions)
      if (this.agents.has(session?.id)) await this.sync(session).catch(() => {});
  }

  /** At service start: every running eligible session listens again at its path. */
  async restore() {
    if (!this.supported) return;
    let sessions = [];
    try {
      sessions = await this.sessions.list();
    } catch {
      return;
    }
    for (const record of sessions) {
      const stored = storedAgent(record, record?.id);
      if (!stored || record.status !== "running" || !agentEligible(record)) continue;
      if (!sessionIdPattern.test(record.id) || this.agents.has(record.id)) continue;
      const binaries = this.binaries();
      if (!binaries) return;
      try {
        await this.syncs.run(async () => {
          if (!this.agents.has(record.id))
            await this.start(record.id, { ...stored, binaries });
        });
      } catch (error) {
        this.log.error(
          "Session SSH agent could not be restored:",
          error?.code || "error",
        );
        continue;
      }
      await this.sync(record).catch(() => {});
    }
  }

  removeSessionFolder(id) {
    removeBelow(path.join(this.dataDir, "ssh-agents"), sessionFolder(this.dataDir, id));
  }

  removeSocketFolder(id, token) {
    const { root, socketPath } = agentSocketLocation(this.dataDir, id, token, {
      home: this.home,
      warn: () => {},
    });
    removeBelow(root, path.dirname(socketPath));
  }

  remove(operation) {
    try {
      operation();
    } catch (error) {
      this.log.error(
        "Session SSH agent folder could not be removed:",
        error?.code || "error",
      );
    }
  }

  // Closes the listener and removes the session folder and the own token folder.
  async teardown(id, token) {
    const agent = this.agents.get(id);
    this.agents.delete(id);
    await agent?.socket.close();
    this.remove(() => this.removeSessionFolder(id));
    const own = agent?.token ?? token;
    if (own) this.remove(() => this.removeSocketFolder(id, own));
  }

  /** On stop: flush the audit, close the listener, remove the session's folders. */
  async discard(id) {
    if (typeof id !== "string" || !sessionIdPattern.test(id)) return;
    this.agentAudit.flush(id);
    await this.syncs.run(() =>
      this.teardown(id, storedAgent(this.record(id), id)?.token),
    );
  }

  status(session) {
    if (!this.supported)
      return { state: "unavailable", reason: "openssh-too-old", aliases: {} };
    const agent = this.agents.get(session?.id);
    if (!agent || !this.current(session, agent))
      return { state: "unavailable", reason: "not-eligible", aliases: {} };
    return { state: "ready", aliases: readSessionAliases(this.dataDir, session.id) };
  }

  /** On shutdown: listeners close, folders stay for the restart at the same paths. */
  async close() {
    await this.syncs.run(async () => {
      for (const [id, agent] of this.agents) {
        this.agentAudit.flush(id);
        await agent.socket.close();
      }
      this.agents.clear();
    });
  }
}
