// One SSH agent per agent (OpenClaw) with shell and SSH grants: the agent counterpart
// of the coding sessions' (ssh-session-agents.js). The socket signs only for the
// trusted hosts of the agent's SSH holder (itself, or a temporary member's lead while
// it shares SSH), read live on every signature; its folder
// `<dataDir>/ssh-agents/_agents/<id>/` holds 280's config, wrappers and aliases plus
// `shell-env.sh` (sourced by the exec shell wrapper) and `state.json` (the socket
// token, so a restart listens at the same path). Sockets, files and retries live in
// the registry shared with the sessions (ssh-agent-registry.js); changes are heard
// through `registry.listen("agent", ...)`.
import fs from "node:fs";
import path from "node:path";
import { rsyncWord, shellWord } from "../ssh/ssh-agent-launch.js";
import { agentHosts } from "../ssh/ssh-agent-policy.js";
import {
  AGENT_FOLDER,
  ownerKey,
  tokenPattern,
  validSessionId,
} from "../ssh/ssh-agent-shared.js";
import { newAgentToken } from "../ssh/ssh-agent-socket.js";
import { removeBelow } from "../ssh/ssh-session-agent-files.js";
import { SSH_AGENT_SOCK_ENV, SSH_CONFIG_ENV } from "../ssh/ssh-session-agents.js";
import { ownerFolder, writeOwnerFile } from "../ssh/ssh-session-config.js";
import { isUserAgent } from "../users/user-access.js";
import { sshFromLead } from "./assistant-access.js";
import { shellQuote } from "./exec-shell.js";
import { personalEligible, personalShell } from "./native-capabilities.js";

// The grant modes whose hosts enter the socket. AssistantAccess reads the former
// "routines" mode as "trusted" (assistant-access-table.js).
export const agentSshModes = ["trusted"];

const maxState = 4096;
const agentOwner = (id) => ({ kind: "agent", id });

// Why an agent gets no socket whatever its grants, or null: an archived agent, a
// user agent (hard lock), a temporary member not using its lead's SSH, no shell.
function ineligibility(assistant) {
  if (!assistant || !validSessionId(assistant.id)) return "not-eligible";
  if (assistant.archivedAt || isUserAgent(assistant)) return "not-eligible";
  if (!personalEligible(assistant) && !sshFromLead(assistant)) return "not-eligible";
  if (personalShell(assistant) === "off") return "no-shell";
  return null;
}

/**
 * Whether `assistant` gets an SSH agent: it has shell, is no user agent, is not
 * archived, and `sshAgents` (AssistantAccess.sshAgents(): agents whose SSH holder has
 * a grant of any mode) names it. OpenSSH is checked by the registry.
 */
export function agentSshEligible(assistant, sshAgents) {
  return ineligibility(assistant) === null && !!sshAgents?.has?.(assistant.id);
}

/**
 * The agent's `shell-env.sh`: POSIX lines that point `SSH_AUTH_SOCK`, Git and rsync at
 * the agent's socket and `ssh` wrapper only while the variable is unset, and always
 * name the config and socket for hints and fallbacks.
 */
export function agentShellEnv({ socketPath, configPath, binDir }) {
  const ssh = path.join(binDir, "ssh");
  const unset = (name, value) =>
    `[ -n "\${${name}+x}" ] || export ${name}=${shellQuote(value)}`;
  return [
    "# Written by AgentPier: this agent's SSH agent and host aliases.",
    unset("SSH_AUTH_SOCK", socketPath),
    unset("GIT_SSH_COMMAND", shellWord(ssh)),
    unset("RSYNC_RSH", rsyncWord(ssh)),
    `export ${SSH_CONFIG_ENV}=${shellQuote(configPath)}`,
    `export ${SSH_AGENT_SOCK_ENV}=${shellQuote(socketPath)}`,
    "",
  ].join("\n");
}

// The lstat of a real (not linked) folder, or null.
function realFolder(folder) {
  try {
    const stat = fs.lstatSync(folder);
    return stat.isDirectory() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

// `<dataDir>/ssh-agents`, `_agents` and the agent folder as [dev, ino], or null
// unless each is a real folder.
function folderChain(folder) {
  const ids = [];
  for (const dir of [path.dirname(path.dirname(folder)), path.dirname(folder), folder]) {
    const stat = realFolder(dir);
    if (!stat) return null;
    ids.push(`${stat.dev}:${stat.ino}`);
  }
  return ids.join("/");
}

// The token an agent folder's state.json names: a regular file of at most 4 KiB,
// opened without following a link (O_NOFOLLOW, then fstat), in real folders from
// `<dataDir>/ssh-agents` down that are the same before and after the read, matching
// tokenPattern; otherwise none.
function storedToken(folder) {
  const before = folderChain(folder);
  if (!before) return undefined;
  let fd;
  try {
    const file = path.join(folder, "state.json");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxState) return undefined;
    const token = JSON.parse(fs.readFileSync(fd, "utf8"))?.token;
    if (folderChain(folder) !== before) return undefined;
    return typeof token === "string" && tokenPattern.test(token) ? token : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class AgentShellSsh {
  /**
   * `agents` lists and gets agent profiles; `store` lists the SSH catalog; `access`
   * is AssistantAccess (`sshAgents`, `hasSshGrants`, `sshHolder`, `get`);
   * `maintenance()` refuses
   * every signature while true; the first refresh waits for `restored` (the sessions'
   * restore), so every session token is known before an agent picks one. `onClose`
   * runs first in `close` and `discardAll` (the wiring detaches its hooks there).
   */
  constructor({
    registry,
    agents,
    store,
    access,
    maintenance = () => false,
    restored,
    pathEnv,
    log = console,
    onClose = null,
  }) {
    Object.assign(this, { registry, agents, store, access, maintenance, pathEnv, log });
    this.onClose = onClose;
    this.restored = Promise.resolve(restored).catch(() => {});
    // id -> "no-openssh" | "failed" for eligible agents that run without a socket.
    this.unavailable = new Map();
    this.closed = false;
    registry.tokenSource("agent", () => this.storedTokens());
  }

  get syncs() {
    return this.registry.syncs;
  }

  get agentsFolder() {
    return path.join(this.registry.agentsRoot, AGENT_FOLDER);
  }

  folder(id) {
    return ownerFolder(this.registry.dataDir, agentOwner(id));
  }

  find(id) {
    try {
      return this.agents.get(id) ?? null;
    } catch {
      return null;
    }
  }

  // The agents whose SSH holder has a grant, or null when they cannot be read.
  sshAgents() {
    try {
      return this.access.sshAgents({ strict: true }) ?? new Set();
    } catch {
      return null;
    }
  }

  hasSshGrants(id) {
    try {
      return this.access.hasSshGrants(id) === true;
    } catch {
      return false;
    }
  }

  /** The grants of the agent's SSH holder; none when the holder is archived or gone. */
  grants(assistant) {
    try {
      const holder = this.access.sshHolder(assistant.id);
      const list = this.access.get(holder.id)?.sshAccesses;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  hosts(assistant) {
    const ids = this.grants(assistant)
      .filter((grant) => agentSshModes.includes(grant?.mode))
      .map((grant) => grant.accessId);
    return agentHosts(this.store.list(), ids);
  }

  /** Per signature: the trusted hosts, read live, or null (refused). */
  async authorize(id) {
    if (this.closed) return null;
    try {
      if (this.maintenance()) return null;
    } catch {
      return null;
    }
    const assistant = this.find(id);
    if (ineligibility(assistant) || !this.hasSshGrants(id)) return null;
    return { hosts: this.hosts(assistant) };
  }

  // The folder names below `_agents/`; none while it is missing or not a real folder.
  folderNames() {
    if (!realFolder(this.registry.agentsRoot) || !realFolder(this.agentsFolder))
      return [];
    try {
      return fs.readdirSync(this.agentsFolder);
    } catch {
      return [];
    }
  }

  // `[{ id, token }]` of every agent folder's state.json, for the registry.
  storedTokens() {
    const tokens = [];
    for (const id of this.folderNames()) {
      if (!validSessionId(id)) continue;
      const token = storedToken(this.folder(id));
      if (token) tokens.push({ id, token });
    }
    return tokens;
  }

  /**
   * Reconciles every agent's socket and files. Calls while one waits share it; a call
   * while one runs gets its own pass after it; the sessions' passes never share it.
   */
  async refresh() {
    await this.restored;
    if (this.closed) return;
    return this.syncs.coalesce(
      () => this.syncs.run(() => this.registry.withKeptTokens(() => this.reconcile())),
      "agent",
    );
  }

  /**
   * Before a turn: reconciles only agent `id` (start, rewrite or tear down), coalesced
   * per agent; other agents and stale folders wait for the next `refresh()`.
   */
  async sync(id) {
    await this.restored;
    if (this.closed || !validSessionId(id)) return;
    return this.syncs.coalesce(
      () =>
        this.syncs.run(() => this.registry.withKeptTokens(() => this.reconcileOne(id))),
      `agent:${id}`,
    );
  }

  async reconcileOne(id) {
    if (this.closed) return;
    const assistant = this.find(id);
    // Unreadable or deleted: nothing changes here; refresh() tears deleted ones down.
    if (!assistant) return;
    const changed = new Set();
    const sshAgents = this.sshAgents();
    if (!sshAgents) {
      if (await this.release(id)) changed.add(id);
      if (!ineligibility(assistant)) this.setUnavailable(id, "failed", changed);
    } else if (!agentSshEligible(assistant, sshAgents)) {
      if (this.registry.get(agentOwner(id))) {
        await this.guarded(() => this.discardOne(id));
        changed.add(id);
      }
      this.setUnavailable(id, null, changed);
    } else {
      const reason = this.opensshProblem();
      const binaries = reason ? null : this.registry.binaries(this.pathEnv);
      await this.reconcileAgent(assistant, binaries, reason, changed);
    }
    this.notify(changed);
  }

  opensshProblem() {
    if (!this.registry.openssh) return "no-openssh";
    return this.registry.supported ? null : "openssh-too-old";
  }

  // One wanted agent: its socket and files, or why it runs without; whether it is live.
  async reconcileAgent(assistant, binaries, reason, changed) {
    const { id } = assistant;
    if (!binaries) {
      if (await this.release(id)) changed.add(id);
      this.setUnavailable(id, reason ?? "no-openssh", changed);
      return true;
    }
    try {
      if (await this.ensure(assistant, binaries)) changed.add(id);
    } catch (error) {
      // A failed write keeps the socket (the registry retries); a failed start not.
      changed.add(id);
      if (!this.registry.get(agentOwner(id)))
        this.log.error("Agent SSH agent could not be started:", error?.code || "error");
    }
    const live = !!this.registry.get(agentOwner(id));
    this.setUnavailable(id, live ? null : "failed", changed);
    return live;
  }

  // Agents no longer wanted (not eligible, archived, deleted) lose socket, folder and
  // token. Agents still wanted that cannot run now (no ssh, OpenSSH too old, grants
  // unreadable) only lose the socket: folder and token stay for the same path later.
  async reconcile() {
    if (this.closed) return;
    let profiles;
    try {
      profiles = this.agents.list() ?? [];
    } catch {
      // Unknown who exists: tear nothing down.
      return;
    }
    const changed = new Set();
    const sshAgents = this.sshAgents();
    if (!sshAgents) {
      for (const entry of this.registry.entries("agent")) await this.release(entry.id);
      for (const assistant of profiles)
        if (!ineligibility(assistant))
          this.setUnavailable(assistant.id, "failed", changed);
      this.notify(changed);
      return;
    }
    const desired = profiles.filter((a) => agentSshEligible(a, sshAgents));
    const keep = new Set(desired.map((a) => a.id));
    const reason = this.opensshProblem();
    const binaries =
      desired.length && !reason ? this.registry.binaries(this.pathEnv) : null;
    for (const assistant of desired)
      if (!(await this.reconcileAgent(assistant, binaries, reason, changed)))
        keep.delete(assistant.id);
    for (const entry of this.registry.entries("agent"))
      if (!keep.has(entry.id)) {
        await this.guarded(() => this.discardOne(entry.id));
        changed.add(entry.id);
      }
    for (const name of this.folderNames())
      if (!keep.has(name)) await this.guarded(() => this.removeFolder(name));
    const wanted = new Set(desired.map((a) => a.id));
    for (const id of this.unavailable.keys())
      if (!wanted.has(id)) this.setUnavailable(id, null, changed);
    this.notify(changed);
  }

  notify(changed) {
    if (changed.size) this.registry.notify("agent", [...changed]);
  }

  // One teardown that throws never stops the pass or its notification.
  async guarded(operation) {
    try {
      await operation();
    } catch (error) {
      this.log.error("Agent SSH agent could not be removed:", error?.code || "error");
    }
  }

  // Closes a wanted agent's socket and keeps its folder and token; whether it was live.
  async release(id) {
    const owner = agentOwner(id);
    if (!this.registry.get(owner)) return false;
    await this.registry.release(owner);
    return true;
  }

  setUnavailable(id, reason, changed) {
    if ((this.unavailable.get(id) ?? null) === reason) return;
    if (reason) this.unavailable.set(id, reason);
    else this.unavailable.delete(id);
    changed.add(id);
  }

  // Starts the agent's socket (at its stored token's path when that token is free)
  // and writes its files quietly; resolves whether anything changed.
  async ensure(assistant, binaries) {
    const { id } = assistant;
    const owner = agentOwner(id);
    const folder = this.folder(id);
    let entry = this.registry.get(owner);
    let started = false;
    if (!entry) {
      const stored = storedToken(folder);
      const token =
        stored && !this.registry.tokenInUse(stored, owner) ? stored : newAgentToken();
      try {
        entry = await this.registry.start(owner, {
          token,
          binaries: { ...binaries },
          authorize: () => this.authorize(id),
          resync: () => this.refresh(),
        });
        if (token !== stored)
          writeOwnerFile(
            this.registry.agentsRoot,
            folder,
            "state.json",
            `${JSON.stringify({ token })}\n`,
          );
      } catch (error) {
        await this.registry.teardown(owner, token);
        throw error;
      }
      started = true;
    } else if (JSON.stringify(entry.binaries) !== JSON.stringify(binaries)) {
      entry.binaries = { ...binaries };
    }
    const shellEnv = agentShellEnv({
      socketPath: entry.location.socketPath,
      configPath: path.join(folder, "ssh_config"),
      binDir: path.join(folder, "bin"),
    });
    const result = await this.registry.write(owner, async () => this.hosts(assistant), {
      shellEnv,
      quiet: true,
    });
    return started || result === "written";
  }

  // Closes a live agent's socket, removes its folders and flushes its audit.
  async discardOne(id) {
    const owner = agentOwner(id);
    await this.registry.teardown(owner);
    this.registry.agentAudit.flush(ownerKey(owner));
  }

  // A folder below `_agents/` of no wanted agent: its token folder goes with it.
  async removeFolder(name) {
    if (validSessionId(name)) {
      await this.registry.teardown(agentOwner(name), storedToken(this.folder(name)));
      return;
    }
    try {
      removeBelow(this.registry.agentsRoot, path.join(this.agentsFolder, name));
    } catch (error) {
      this.log.error(
        "Agent SSH agent folder could not be removed:",
        error?.code || "error",
      );
    }
  }

  // The live entry of an agent that is still eligible by its profile, or undefined.
  entry(assistant) {
    if (ineligibility(assistant)) return undefined;
    return this.registry.get(agentOwner(assistant.id));
  }

  /** `[<folder>/bin]` while the agent has a socket: its exec PATH entry and marker. */
  shellPath(assistant) {
    return this.entry(assistant) ? [path.join(this.folder(assistant.id), "bin")] : [];
  }

  /** The same directories, only those that exist now (approval analysis). */
  shellDirs(assistant) {
    return this.shellPath(assistant).filter((dir) => fs.existsSync(dir));
  }

  /** `{ [assistantId]: directories }` for a Gateway start. */
  shellPaths(profiles = []) {
    const paths = {};
    for (const profile of profiles) {
      const dirs = this.shellPath(profile);
      if (dirs.length) paths[profile.id] = dirs;
    }
    return paths;
  }

  /** Access id -> alias of the agent's trusted hosts; empty without a socket. */
  aliases(id) {
    const assistant = validSessionId(id) ? this.find(id) : null;
    return this.entry(assistant) ? this.registry.aliases(agentOwner(id)) : {};
  }

  /**
   * `{ state: "ready", aliases, sshConfig? }` or `{ state: "unavailable", reason }`
   * with reason `not-eligible`, `no-shell`, `no-hosts`, `no-openssh`,
   * `openssh-too-old` or `failed`. Never a path or token.
   */
  status(id) {
    const unavailable = (reason) => ({ state: "unavailable", reason });
    const assistant = validSessionId(id) ? this.find(id) : null;
    const reason = ineligibility(assistant);
    if (reason) return unavailable(reason);
    // An unreadable access store is a failure, not "no hosts".
    if (!this.hasSshGrants(id))
      return unavailable(this.sshAgents() === null ? "failed" : "no-hosts");
    if (!this.registry.openssh) return unavailable("no-openssh");
    if (!this.registry.supported) return unavailable("openssh-too-old");
    if (!this.entry(assistant))
      return unavailable(this.unavailable.get(id) ?? "not-eligible");
    const code = this.registry.userConfigProblem(agentOwner(id));
    return {
      state: "ready",
      aliases: this.registry.aliases(agentOwner(id)),
      ...(code ? { sshConfig: code } : {}),
    };
  }

  // Runs `onClose` once; a throwing one never stops the close.
  detach() {
    const onClose = this.onClose;
    this.onClose = null;
    try {
      onClose?.();
    } catch {}
  }

  /** Feature switched off: every agent socket closes, its folders and tokens go. */
  async discardAll() {
    this.detach();
    this.closed = true;
    const changed = new Set();
    await this.syncs.run(async () => {
      for (const entry of this.registry.entries("agent")) {
        await this.guarded(() => this.discardOne(entry.id));
        changed.add(entry.id);
      }
      for (const name of this.folderNames())
        await this.guarded(() => this.removeFolder(name));
    });
    this.unavailable.clear();
    this.notify(changed);
  }

  /** Shutdown: the agent sockets close, folders and tokens stay for the restart. */
  async close() {
    this.detach();
    this.closed = true;
    await this.registry.close("agent");
  }
}
