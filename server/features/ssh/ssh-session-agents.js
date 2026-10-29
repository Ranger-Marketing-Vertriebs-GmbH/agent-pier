// One SSH agent per eligible session: a socket that signs only for the session's live
// grants (ssh-agent-socket.js) and the files that let plain OpenSSH reach them
// (ssh-session-config.js). The agent's generation and socket token live in the session
// record (`sshAgent`), so a restart listens again at the same path and a reload's new
// generation retires the old one. The sockets, files and retries live in the registry
// shared with the agents' sockets (ssh-agent-registry.js); this adapter decides which
// sessions get one and which hosts they sign for. Launch wiring (env, sandbox grants)
// is the caller's: `launchDetails(id)` names the paths and grants it needs.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { SshAgentRegistry } from "./ssh-agent-registry.js";
import { agentHosts } from "./ssh-agent-policy.js";
import { ownerKey, validSessionId } from "./ssh-agent-shared.js";
import { newAgentToken } from "./ssh-agent-socket.js";
import {
  realOrSelf,
  recordedBinaries,
  sessionRecord,
  storedAgent,
  storedSessionTokens,
  storedToken,
} from "./ssh-session-agent-files.js";
import { readSessionAliases, sessionFolder } from "./ssh-session-config.js";

// The session's generated ssh_config and its agent socket, for hints and fallbacks.
export const SSH_CONFIG_ENV = "AGENTPIER_SSH_CONFIG";
export const SSH_AGENT_SOCK_ENV = "AGENTPIER_SSH_AUTH_SOCK";

const sessionOwner = (id) => ({ kind: "session", id });

const codingTools = new Set(["codex", "claude", "opencode"]);

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

export class SessionSshAgents {
  constructor({
    dataDir,
    store,
    grants,
    sessions,
    audit,
    openssh,
    home,
    log = console,
    retryDelays,
    userConfig = null,
    registry = null,
  }) {
    this.dataDir = path.resolve(dataDir);
    Object.assign(this, { store, grants, sessions, log });
    // Shared with the agents' sockets in a service; a stand-alone one otherwise.
    this.registry =
      registry ??
      new SshAgentRegistry({
        dataDir,
        audit,
        openssh,
        home,
        log,
        retryDelays,
        userConfig,
      });
    // id -> "no-openssh" | "failed" for eligible sessions that run without an agent.
    this.unavailable = new Map();
    // Called with a session id once its aliases or agent state changed (the service
    // wiring listens on the registry instead).
    this.onChange = null;
    this.registry.listen("session", (id) => this.onChange?.(id));
    // Tokens of session records whose agent does not listen (yet) stay taken.
    this.registry.tokenSource("session", () => storedSessionTokens(this.dataDir));
  }

  get supported() {
    return this.registry.supported;
  }

  get agentsRoot() {
    return this.registry.agentsRoot;
  }

  get openssh() {
    return this.registry.openssh;
  }

  get syncs() {
    return this.registry.syncs;
  }

  get userConfig() {
    return this.registry.userConfig;
  }

  set userConfig(value) {
    this.registry.userConfig = value;
  }

  binaries(pathEnv) {
    return this.registry.binaries(pathEnv);
  }

  identity(keyId) {
    return this.registry.identity(keyId);
  }

  agent(id) {
    return validSessionId(id) ? this.registry.get(sessionOwner(id)) : undefined;
  }

  record(id) {
    return sessionRecord(this.dataDir, id);
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

  // Per signature; the registry asks only while the entry is the session's live one.
  // The project goes on the entry first, so a refusal's audit row names it, too.
  async authorize(agent) {
    const record = this.record(agent.id);
    if (!this.current(record, agent)) return null;
    agent.projectId = record.sshTools?.project?.projectId;
    return { hosts: agentHosts(this.store.list(), await this.grants.effective(record)) };
  }

  start(id, { token, generation, binaries }) {
    return this.registry.start(sessionOwner(id), {
      token,
      generation,
      binaries,
      authorize: (agent) => this.authorize(agent),
      resync: () => {
        const record = this.record(id);
        return record ? this.sync(record) : undefined;
      },
    });
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
      const previous = this.agent(id);
      const token = previous?.token ?? storedToken(record, id) ?? newAgentToken();
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
        await this.registry.teardown(sessionOwner(id), token);
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
    const agent = this.agent(id);
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

  // The session's granted hosts, read inside the registry's write so that a catalog
  // or grant failure fails the write like a file error (withoutHosts, retry).
  syncAgent(agent, session) {
    return this.registry.write(sessionOwner(agent.id), async () =>
      agentHosts(this.store.list(), await this.grants.effective(session)),
    );
  }

  /** Resolves "written" or "unchanged"; syncs run one at a time. */
  sync(session) {
    return this.syncs.run(() => this.syncOnce(session));
  }

  async syncOnce(session) {
    const agent = this.agent(session?.id);
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
      if (this.agent(session?.id)) await this.sync(session).catch(() => {});
  }

  /**
   * At service start: every running eligible session listens again at its path. The
   * stored tokens are read once for the whole pass.
   */
  restore() {
    return this.registry.withKeptTokens(() => this.restoreAll());
  }

  async restoreAll() {
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
      if (!validSessionId(record.id) || this.agent(record.id)) continue;
      // The binaries chosen at launch; PATH (the server's) only when they are gone.
      const binaries =
        recordedBinaries(stored.binaries, realOrSelf(this.agentsRoot)) ?? this.binaries();
      if (!binaries) {
        this.unavailable.set(record.id, "no-openssh");
        continue;
      }
      try {
        await this.syncs.run(async () => {
          if (!this.agent(record.id))
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

  /**
   * On stop: close the listener, flush the audit, remove the session's folders. A
   * reload that ends without an agent passes `keepReason`, so the status still says why.
   */
  async discard(id, { keepReason = false } = {}) {
    if (!validSessionId(id)) return;
    if (!keepReason) this.unavailable.delete(id);
    const owner = sessionOwner(id);
    await this.syncs.run(() =>
      this.registry.teardown(owner, storedToken(this.record(id), id)),
    );
    // After the close: no signature can open a new audit window behind the flush.
    this.registry.agentAudit.flush(ownerKey(owner));
    this.registry.changed(owner);
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
    const agent = this.agent(session?.id);
    if (!agent || !this.current(session, agent))
      return unavailable(this.unavailable.get(session?.id) ?? "not-eligible");
    return {
      state: "ready",
      aliases: readSessionAliases(this.dataDir, session.id),
      ...this.userConfigProblem(session.id),
    };
  }

  userConfigProblem(id) {
    const code = this.registry.userConfigProblem(sessionOwner(id));
    return code ? { sshConfig: code } : {};
  }

  /** On shutdown: listeners close, folders stay for the restart at the same paths. */
  close() {
    return this.registry.close("session");
  }
}
