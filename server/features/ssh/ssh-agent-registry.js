// Every live SSH agent socket of this AgentPier process, of coding sessions and of
// agents alike, keyed by owner (`session:<id>`, `agent:<id>`). The registry starts a
// socket, writes and rewrites the owner's files (ssh-session-config.js), retries a
// failed write, tears an owner down and hands every owner's config to the
// `~/.ssh/config` dispatcher (ssh-user-config.js). Which hosts an owner may use, and
// when it starts or goes, is the adapters' (ssh-session-agents.js for sessions).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncQueue } from "../../lib/sync-queue.js";
import { privateFile } from "../memory/memory-validation.js";
import { createAgentAudit } from "./ssh-agent-audit.js";
import { codedError, keyIdPattern, ownerKey, tokenPattern } from "./ssh-agent-shared.js";
import { agentSocketLocation, SessionAgentSocket } from "./ssh-agent-socket.js";
import { supportsSessionBind } from "./ssh-openssh-version.js";
import { removeBelow } from "./ssh-session-agent-files.js";
import {
  ownerFolder,
  readOwnerAliases,
  resolveOpenSshBinaries,
  sessionAliases,
  writeOwnerFiles,
} from "./ssh-session-config.js";

const maxIdentity = 65536;
const labels = { session: "Session SSH agent", agent: "Agent SSH agent" };

// What a written set of files depends on; equal fingerprints need no rewrite.
function fingerprint(entry, hosts, aliases, shellEnv) {
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
    binaries: entry.binaries,
    socketPath: entry.location.socketPath,
    shellEnv: typeof shellEnv === "string" ? shellEnv : null,
  });
}

const sameOwner = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id;

export class SshAgentRegistry {
  constructor({
    dataDir,
    audit,
    openssh,
    home = os.homedir(),
    log = console,
    retryDelays = [1000, 5000, 30000],
    userConfig = null,
  }) {
    this.dataDir = path.resolve(dataDir);
    Object.assign(this, { openssh, home, log, retryDelays });
    // The ~/.ssh/config block and its dispatcher (ssh-user-config.js), when wired.
    this.userConfig = userConfig;
    this.agentAudit = createAgentAudit({ append: (event) => audit?.append(event) });
    // ownerKey -> entry, in start order.
    this.owners = new Map();
    // Starts, writes and teardowns of both kinds run one at a time.
    this.syncs = new SyncQueue();
    // kind -> Set of change listeners; kind -> functions naming stored tokens.
    this.listeners = new Map();
    this.tokenSources = new Map();
    // kind -> stored tokens, read once per pass (withKeptTokens); null outside one.
    this.kept = null;
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

  /** The private key of one catalog key, read per signature and never kept. */
  identity(keyId) {
    if (typeof keyId !== "string" || !keyIdPattern.test(keyId))
      throw codedError("SSH_AGENT_KEY_UNSUPPORTED", "Invalid SSH key id");
    return privateFile(path.join(this.dataDir, "ssh", "identities", keyId, "identity"), {
      max: maxIdentity,
    });
  }

  get(owner) {
    return this.owners.get(ownerKey(owner));
  }

  entries(kind) {
    const all = [...this.owners.values()];
    return kind ? all.filter((entry) => entry.owner.kind === kind) : all;
  }

  /**
   * Listens at the owner's socket path and returns its entry; an entry the owner
   * already has is closed first. `authorize(entry)` answers each signature with
   * `{ hosts, projectId? }` or null, and is asked only while this entry is the
   * owner's live one, before and after it answers; it may set `entry.projectId` for
   * the audit before it reads the hosts. `resync` rewrites the owner's files after a
   * failed write. A token another owner listens with or keeps is refused
   * (`SSH_AGENT_TOKEN_IN_USE`): both would share one socket folder. Call it inside
   * `syncs.run`, like `write` and `teardown`.
   */
  async start(owner, { token, generation, binaries, authorize, resync }) {
    const key = ownerKey(owner);
    const label = labels[owner.kind];
    if (this.tokenInUse(token, owner))
      throw codedError("SSH_AGENT_TOKEN_IN_USE", "SSH agent token in use");
    const previous = this.owners.get(key);
    if (previous) {
      this.owners.delete(key);
      clearTimeout(previous.timer);
      await previous.socket.close();
    }
    const location = agentSocketLocation(this.dataDir, owner.id, token, {
      home: this.home,
      warn: (code) => this.log.warn(`${label} socket:`, code),
    });
    const entry = {
      owner: { kind: owner.kind, id: owner.id },
      id: owner.id,
      token,
      generation,
      binaries,
      location,
      resync,
      written: null,
      shellEnv: undefined,
      attempts: 0,
      timer: null,
      projectId: undefined,
    };
    const scope = () => ({ owner: entry.owner, projectId: entry.projectId });
    entry.socket = new SessionAgentSocket({
      socketPath: location.socketPath,
      root: location.root,
      authorize: async () => {
        if (this.owners.get(key) !== entry) return null;
        const grant = await authorize(entry);
        // A replace or teardown during the answer: the entry signs nothing more.
        if (!grant || this.owners.get(key) !== entry) return null;
        if ("projectId" in grant) entry.projectId = grant.projectId;
        return { hosts: grant.hosts };
      },
      readIdentity: (keyId) => this.identity(keyId),
      onSigned: (host) => this.agentAudit.connected({ ...scope(), host }),
      onDenied: (code) => this.agentAudit.denied({ ...scope(), code }),
    });
    await entry.socket.listen();
    this.owners.set(key, entry);
    return entry;
  }

  /**
   * Writes the owner's files for `hosts` (or for what an async function of no
   * arguments returns), plus `shell-env.sh` when `shellEnv` is a string; resolves
   * "written" or "unchanged". Any error is a failure: the alias files go, so a CLI
   * never trusts a partial set, while `bin/` keeps pass-through wrappers for the
   * owner's own Git and rsync. A bounded retry through the entry's `resync` follows.
   * Call it inside `syncs.run` (it never queues itself: a nested run would wait on
   * itself). An entry replaced or torn down while the hosts are read is left alone:
   * the write resolves "unchanged" and no folder is re-created. A `quiet` write tells
   * neither the dispatcher nor the listeners; a pass calls `notify` once instead.
   */
  async write(owner, hosts, { shellEnv, quiet = false } = {}) {
    const entry = this.get(owner);
    if (!entry) throw codedError("SSH_AGENT_NOT_STARTED", "SSH agent not started");
    const label = labels[owner.kind];
    const key = ownerKey(owner);
    try {
      const list = typeof hosts === "function" ? await hosts() : hosts;
      if (this.owners.get(key) !== entry) return "unchanged";
      const aliases = sessionAliases(list, readOwnerAliases(this.dataDir, owner));
      const written = fingerprint(entry, list, aliases, shellEnv);
      const folder = ownerFolder(this.dataDir, owner);
      if (written === entry.written && fs.existsSync(path.join(folder, "ssh_config")))
        return "unchanged";
      entry.written = null;
      entry.shellEnv = shellEnv;
      const { skipped } = writeOwnerFiles(this.agentsRoot, folder, {
        hosts: list,
        aliases,
        socketPath: entry.location.socketPath,
        binaries: entry.binaries,
        shellEnv,
      });
      if (skipped.length) this.log.warn(`${label} skipped hosts:`, skipped.join(", "));
      entry.written = written;
      entry.attempts = 0;
      if (!quiet) this.changed(owner);
      return "written";
    } catch (error) {
      entry.written = null;
      if (this.owners.get(key) !== entry) throw error;
      this.withoutHosts(entry);
      // The aliases are gone: the live topics must not keep showing them.
      if (!quiet) this.changed(owner);
      this.log.error(`${label} files could not be written:`, error?.code || "error");
      this.retry(entry);
      throw error;
    }
  }

  // The zero-host set: no aliases, wrappers that only exec the real binaries. When
  // even that fails (a planted link), the alias files are unlinked, never followed,
  // and it is tried once more. `bin/` and `shell-env.sh` stay.
  withoutHosts(entry) {
    const folder = ownerFolder(this.dataDir, entry.owner);
    const empty = () =>
      writeOwnerFiles(this.agentsRoot, folder, {
        hosts: [],
        aliases: {},
        socketPath: entry.location.socketPath,
        binaries: entry.binaries,
        shellEnv: entry.shellEnv,
      });
    try {
      empty();
      return;
    } catch {
      // Clear the alias files below.
    }
    for (const name of ["ssh_config", "known_hosts", "aliases.json", "keys"])
      this.remove(entry.owner, () =>
        removeBelow(this.agentsRoot, path.join(folder, name)),
      );
    try {
      empty();
    } catch {
      // The alias files are gone; the retry tries again.
    }
  }

  retry(entry) {
    if (entry.timer || entry.attempts >= this.retryDelays.length) return;
    const delay = this.retryDelays[entry.attempts];
    entry.attempts += 1;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.owners.get(ownerKey(entry.owner)) !== entry) return;
      try {
        Promise.resolve(entry.resync?.()).catch(() => {});
      } catch {
        // The next write tries again.
      }
    }, delay);
    entry.timer.unref?.();
  }

  /**
   * Hands every live owner's config to the dispatcher (checked with the real ssh in
   * the background, ssh-user-config-sync.js), then tells the owner's kind.
   */
  changed(owner) {
    this.notify(owner.kind, [owner.id]);
  }

  /** `changed` for many owners of one kind: one dispatcher update, then each id. */
  notify(kind, ids) {
    this.userConfig?.update(
      this.entries().map((entry) => ({
        configPath: path.join(ownerFolder(this.dataDir, entry.owner), "ssh_config"),
        aliases: Object.values(readOwnerAliases(this.dataDir, entry.owner)),
        ssh: entry.binaries?.ssh,
      })),
    );
    for (const id of ids)
      for (const listener of this.listeners.get(kind) ?? []) {
        try {
          listener(id);
        } catch {
          // A listener never fails a sync.
        }
      }
  }

  /** Calls `listener(id)` after an owner of `kind` changed; returns an unsubscribe. */
  listen(kind, listener) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind).add(listener);
    return () => this.listeners.get(kind)?.delete(listener);
  }

  /**
   * Names the tokens owners of `kind` keep while no socket listens (a session record's
   * `sshAgent` before restore, for one): `source()` returns `[{ id, token }]`.
   */
  tokenSource(kind, source) {
    this.tokenSources.set(kind, source);
  }

  /**
   * Runs `task` (a restore or refresh pass) with the stored tokens read once, not
   * once per owner it starts or removes. Live sockets are still checked live, and a
   * token kept after the read is a fresh random one no other owner can name.
   */
  async withKeptTokens(task) {
    if (this.kept) return task();
    this.kept = new Map();
    try {
      return await task();
    } finally {
      this.kept = null;
    }
  }

  storedTokens(kind, source) {
    if (this.kept?.has(kind)) return this.kept.get(kind);
    const stored = source() ?? [];
    this.kept?.set(kind, stored);
    return stored;
  }

  /** Whether an owner other than `exceptOwner` listens with, or keeps, `token`. */
  tokenInUse(token, exceptOwner) {
    if (typeof token !== "string" || !tokenPattern.test(token)) return false;
    for (const entry of this.owners.values())
      if (entry.token === token && !sameOwner(entry.owner, exceptOwner)) return true;
    for (const [kind, source] of this.tokenSources) {
      let stored = [];
      try {
        stored = this.storedTokens(kind, source);
      } catch {
        continue;
      }
      for (const item of stored)
        if (item?.token === token && !sameOwner({ kind, id: item.id }, exceptOwner))
          return true;
    }
    return false;
  }

  aliases(owner) {
    return readOwnerAliases(this.dataDir, owner);
  }

  /** The dispatcher's problem code for the owner's config, or null. */
  userConfigProblem(owner) {
    const configPath = path.join(ownerFolder(this.dataDir, owner), "ssh_config");
    return this.userConfig?.problemFor(configPath) || null;
  }

  remove(owner, operation) {
    try {
      operation();
    } catch (error) {
      this.log.error(
        `${labels[owner.kind]} folder could not be removed:`,
        error?.code || "error",
      );
    }
  }

  /**
   * Closes the owner's listener and removes its folder and its token folder, unless
   * another owner listens with or keeps that token.
   */
  async teardown(owner, token) {
    const key = ownerKey(owner);
    const entry = this.owners.get(key);
    this.owners.delete(key);
    clearTimeout(entry?.timer);
    await entry?.socket.close();
    this.remove(owner, () =>
      removeBelow(this.agentsRoot, ownerFolder(this.dataDir, owner)),
    );
    const own = entry?.token ?? token;
    if (!own || this.tokenInUse(own, owner)) return;
    this.remove(owner, () => {
      const { root, socketPath } = agentSocketLocation(this.dataDir, owner.id, own, {
        home: this.home,
        warn: () => {},
      });
      removeBelow(root, path.dirname(socketPath));
    });
  }

  /**
   * On shutdown (or when one kind switches off): the listeners of `kind`, or of every
   * owner, close and their audit flushes; folders stay for a restart at the same paths.
   */
  async close(kind) {
    await this.syncs.run(async () => {
      for (const [key, entry] of [...this.owners]) {
        if (kind && entry.owner.kind !== kind) continue;
        this.owners.delete(key);
        clearTimeout(entry.timer);
        try {
          await entry.socket.close();
        } catch (error) {
          this.log.error(
            `${labels[entry.owner.kind]} could not be closed:`,
            error?.code || "error",
          );
        }
        this.agentAudit.flush(key);
      }
    });
  }
}
