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
 * Whether a launch or a session record gets an agent (R15, R27). Shell sessions do;
 * Codex, Claude Code and OpenCode only with the SSH tools. Login, headless pipeline
 * and agent (assistant) sessions never do.
 */
export function agentEligible({ tool, purpose, pipeline, sshTools } = {}) {
  if (purpose === "login" || pipeline?.headless) return false;
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
  return { generation: agent.generation, token: agent.token, binaries: agent.binaries };
}

// The socket token a record names: its agent's, or the one a reload's stop retired
// (`sshAgentRetired`, session-replacement.js), which never authorizes anything but
// still locates the socket folder for a later prepare or discard.
function storedToken(record, id) {
  const token = storedAgent(record, id)?.token ?? record?.sshAgentRetired?.token;
  return record?.id === id && typeof token === "string" && tokenPattern.test(token)
    ? token
    : undefined;
}

function realOrSelf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// A recorded binary that still is an executable file outside the session wrappers.
function usableBinary(file, skipRoot) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file))
    return false;
  try {
    const real = fs.realpathSync(file);
    if (real === skipRoot || real.startsWith(`${skipRoot}${path.sep}`)) return false;
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The binaries kept in the record at prepare time, or null once `ssh` is gone.
function recordedBinaries(binaries, skipRoot) {
  if (!usableBinary(binaries?.ssh, skipRoot)) return null;
  const found = {};
  for (const name of ["ssh", "scp", "sftp"])
    if (usableBinary(binaries[name], skipRoot)) found[name] = binaries[name];
  return found;
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
    retryDelays = [1000, 5000, 30000],
  }) {
    this.dataDir = path.resolve(dataDir);
    Object.assign(this, { store, grants, sessions, openssh, home, log, retryDelays });
    // id -> "no-openssh" | "failed" for eligible sessions that run without an agent.
    this.unavailable = new Map();
    this.agentAudit = createAgentAudit({ append: (event) => audit?.append(event) });
    this.agents = new Map();
    this.syncs = new SyncQueue();
    // Called with a session id once its aliases or agent state changed (assigned by the
    // wiring: the live `job.ssh-tools` topic carries `agent`).
    this.onChange = null;
  }

  get supported() {
    return supportsSessionBind(this.openssh);
  }

  get agentsRoot() {
    return path.join(this.dataDir, "ssh-agents");
  }

  binaries(pathEnv) {
    return resolveOpenSshBinaries(pathEnv ?? process.env.PATH, [this.agentsRoot]);
  }

  record(id) {
    try {
      const value = readJSON(path.join(this.dataDir, "sessions", `${id}.json`), null);
      return value && typeof value === "object" && value.id === id ? value : null;
    } catch {
      return null;
    }
  }

  // The record belongs to this listener: running (or relaunching in a reload whose
  // replacement started, so the new CLI's first ssh is not refused before the record
  // says running), eligible, same generation.
  current(record, agent) {
    const live =
      record?.status === "running" ||
      (record?.reload?.state === "reloading" &&
        record.reload.replacementStarted === true);
    return Boolean(
      record?.id === agent.id &&
      live &&
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
    agent.attempts = 0;
    agent.timer = null;
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
   * `sshAgent: { enabled, generation, token, binaries }`, or the launch unchanged when
   * the session is not eligible, OpenSSH is older than 8.9, no `ssh` is on PATH or the
   * agent could not start (logged; the session launches without it). A reload keeps
   * the socket token (same path) and takes a new generation; of two concurrent
   * prepares for one id, the later one's generation is the live one.
   */
  async prepare({ id, account, launch, purpose, pipeline } = {}) {
    const tool = account?.tool;
    if (
      !this.supported ||
      !agentEligible({ tool, purpose, pipeline, sshTools: launch?.sshTools })
    )
      return launch;
    sessionFolder(this.dataDir, id);
    const binaries = this.binaries(launch?.env?.PATH);
    if (!binaries) {
      this.unavailable.set(id, "no-openssh");
      return launch;
    }
    return this.syncs.run(async () => {
      const record = this.record(id);
      const previous = this.agents.get(id);
      const token = previous?.token ?? storedToken(record, id) ?? newAgentToken();
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
        this.unavailable.set(id, "failed");
        this.log.error("Session SSH agent could not be started:", error?.code || "error");
        return launch;
      }
      this.unavailable.delete(id);
      return {
        ...launch,
        sshAgent: { enabled: true, generation, token, binaries: { ...binaries } },
      };
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
        ...Object.values(agent.binaries).map((file) => ({ access: "read", path: file })),
      ],
    };
  }

  // Any error is a failure: the alias files go, so the CLI never trusts a partial set,
  // while `bin/` keeps pass-through wrappers for the user's own Git and rsync (their
  // GIT_SSH_COMMAND and RSYNC_RSH name `bin/ssh`). A bounded retry follows.
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
      agent.attempts = 0;
      this.changed(agent.id);
      return "written";
    } catch (error) {
      agent.written = null;
      this.withoutHosts(agent);
      // The aliases are gone: the live topic must not keep showing them.
      this.changed(agent.id);
      this.log.error(
        "Session SSH agent files could not be written:",
        error?.code || "error",
      );
      this.retry(agent);
      throw error;
    }
  }

  // The zero-host set: no aliases, wrappers that only exec the real binaries. When
  // even that fails (a planted link), the alias files are unlinked, never followed,
  // and it is tried once more. `bin/` is never removed.
  withoutHosts(agent) {
    const folder = sessionFolder(this.dataDir, agent.id);
    const empty = () =>
      writeSessionFiles(folder, {
        hosts: [],
        aliases: {},
        socketPath: agent.location.socketPath,
        binaries: agent.binaries,
      });
    try {
      empty();
      return;
    } catch {
      // Clear the alias files below.
    }
    for (const name of ["ssh_config", "known_hosts", "aliases.json", "keys"])
      this.remove(() => removeBelow(this.agentsRoot, path.join(folder, name)));
    try {
      empty();
    } catch {
      // The alias files are gone; the retry tries again.
    }
  }

  retry(agent) {
    if (agent.timer || agent.attempts >= this.retryDelays.length) return;
    const delay = this.retryDelays[agent.attempts];
    agent.attempts += 1;
    agent.timer = setTimeout(() => {
      agent.timer = null;
      if (this.agents.get(agent.id) !== agent) return;
      const record = this.record(agent.id);
      if (record) this.sync(record).catch(() => {});
    }, delay);
    agent.timer.unref?.();
  }

  changed(id) {
    try {
      this.onChange?.(id);
    } catch {
      // A listener never fails a sync.
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
      // The binaries chosen at launch; PATH (the server's) only when they are gone.
      const binaries =
        recordedBinaries(stored.binaries, realOrSelf(this.agentsRoot)) ?? this.binaries();
      if (!binaries) {
        this.unavailable.set(record.id, "no-openssh");
        continue;
      }
      try {
        await this.syncs.run(async () => {
          if (!this.agents.has(record.id))
            await this.start(record.id, { ...stored, binaries: { ...binaries } });
        });
      } catch (error) {
        this.unavailable.set(record.id, "failed");
        this.log.error(
          "Session SSH agent could not be restored:",
          error?.code || "error",
        );
        continue;
      }
      this.unavailable.delete(record.id);
      await this.sync(record).catch(() => {});
    }
  }

  removeSessionFolder(id) {
    removeBelow(this.agentsRoot, sessionFolder(this.dataDir, id));
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
    clearTimeout(agent?.timer);
    await agent?.socket.close();
    this.remove(() => this.removeSessionFolder(id));
    const own = agent?.token ?? token;
    if (own) this.remove(() => this.removeSocketFolder(id, own));
  }

  /**
   * On stop: close the listener, flush the audit, remove the session's folders. A
   * reload that ends without an agent passes `keepReason`, so the status still says why.
   */
  async discard(id, { keepReason = false } = {}) {
    if (typeof id !== "string" || !sessionIdPattern.test(id)) return;
    if (!keepReason) this.unavailable.delete(id);
    await this.syncs.run(() => this.teardown(id, storedToken(this.record(id), id)));
    // After the close: no signature can open a new audit window behind the flush.
    this.agentAudit.flush(id);
    this.changed(id);
  }

  /**
   * `ready` with the aliases, or `unavailable` with a reason: `no-openssh` (no `ssh`
   * found), `openssh-too-old` (below 8.9), `failed` (the agent could not start) or
   * `not-eligible`.
   */
  status(session) {
    const unavailable = (reason) => ({ state: "unavailable", reason, aliases: {} });
    if (!this.openssh) return unavailable("no-openssh");
    if (!this.supported) return unavailable("openssh-too-old");
    const agent = this.agents.get(session?.id);
    if (!agent || !this.current(session, agent))
      return unavailable(this.unavailable.get(session?.id) ?? "not-eligible");
    return { state: "ready", aliases: readSessionAliases(this.dataDir, session.id) };
  }

  /** On shutdown: listeners close, folders stay for the restart at the same paths. */
  async close() {
    await this.syncs.run(async () => {
      for (const [id, agent] of this.agents) {
        clearTimeout(agent.timer);
        await agent.socket.close();
        this.agentAudit.flush(id);
      }
      this.agents.clear();
    });
  }
}
