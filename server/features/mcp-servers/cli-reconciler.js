import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { editConfig } from "../extensions/config-edit.js";
import {
  CLI_CONFIG_CHANGED,
  CLI_CONFIG_LAYOUT,
  CLI_CONFIG_TOO_LARGE,
  atomicText,
} from "../extensions/mcp-config.js";
import { cliEntry, cliSupport, entryHash } from "./cli-native.js";

const messages = serverMessages.mcpServers;
// Passes per reconciliation: a lost compare-and-swap is read again and retried.
const attempts = 3;
const changed = () =>
  Object.assign(problem(serverMessages.extensions.cliConfigChanged, 409), {
    code: CLI_CONFIG_CHANGED,
  });
/**
 * Marks `error` as a file problem of `cli` that `guard` reports as `reason`; a file
 * above the read limit is always `too-large`.
 */
const tagged = (error, reason) =>
  Object.assign(error && typeof error === "object" ? error : new Error(String(error)), {
    cliReason: error?.code === CLI_CONFIG_TOO_LARGE ? "too-large" : reason,
  });
const reasonOf = (error) =>
  error?.cliReason ??
  (error?.code === CLI_CONFIG_CHANGED
    ? "changed"
    : error?.code === CLI_CONFIG_LAYOUT
      ? "layout"
      : null);
// Only a stable error code is logged, never a message, path or value.
const codeOf = (error) =>
  typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? `: ${error.code}`
    : "";

/**
 * Keeps each CLI's native MCP entries in step with the central CLI bindings. An entry
 * is AgentPier's while `cli_entries` records it and the file's entry hashes to the
 * recorded or the pending hash; everything else in the file is the owner's and is
 * never modified. Every change is recorded before the file is written, so the next
 * run finishes a change a crash interrupted.
 */
export class CliMcpReconciler {
  constructor({ servers, locate, configs, warn = console.warn }) {
    Object.assign(this, { servers, locate, configs, warn });
    this.entries = servers.cliEntries;
  }

  /** The CLI's native MCP entries by name, across all of its files. */
  read(cli) {
    let locations;
    let configs;
    try {
      locations = this.locate(cli);
      configs = this.configs(locations);
    } catch (error) {
      throw tagged(error, "unreadable");
    }
    const entries = new Map();
    const duplicates = new Set();
    for (const config of configs)
      for (const [name, entry] of Object.entries(config.data[locations.key] || {})) {
        if (entries.has(name)) duplicates.add(name);
        entries.set(name, { entry, config, hash: entryHash(entry) });
      }
    return { locations, configs, entries, duplicates };
  }

  /** What the bindings want in `cli`: serverId → `{ definition, entry, hash }` or `{ definition, reason }`. */
  desired(cli) {
    const bound = new Set(this.servers.bindings("cli", cli));
    const out = new Map();
    for (const definition of this.servers.definitions()) {
      if (!bound.has(definition.id)) continue;
      const support = cliSupport(cli, definition);
      if (!support.supported)
        out.set(definition.id, { definition, reason: support.reason });
      else if (definition.args === null)
        out.set(definition.id, { definition, reason: "invalid" });
      else {
        const secrets = this.servers.secrets(definition.id);
        try {
          const entry = cliEntry(cli, definition, secrets);
          out.set(definition.id, { definition, entry, hash: entryHash(entry) });
        } catch {
          // One definition AgentPier cannot project blocks only its own entry.
          out.set(definition.id, { definition, reason: "invalid" });
        }
      }
    }
    return out;
  }

  /** Every status, change and find for one snapshot of the file; writes nothing. */
  plan(cli, snapshot) {
    const desired = this.desired(cli);
    const rows = this.entries.list(cli);
    const rowOf = new Map(rows.map((row) => [row.serverId, row]));
    const owned = (row, found) =>
      !!found && (found.hash === row.hash || found.hash === row.pendingHash);
    const statuses = {};
    const actions = [];
    const claimed = new Set();
    // Names AgentPier no longer wants: unbound, deleted, renamed or now unsupported.
    for (const row of rows) {
      const want = desired.get(row.serverId);
      if (want?.entry && want.definition.name === row.name) continue;
      const found = snapshot.entries.get(row.name);
      if (owned(row, found) && !snapshot.duplicates.has(row.name)) {
        claimed.add(row.name);
        actions.push({
          type: "remove",
          serverId: row.serverId,
          name: row.name,
          expected: found.hash,
          keep: !!want?.entry,
        });
        // No longer AgentPier's: the entry becomes a find. A renamed server's write
        // records its new name afresh.
      } else actions.push({ type: "forget", serverId: row.serverId });
    }
    for (const [serverId, want] of desired) {
      const name = want.definition.name;
      const row = rowOf.get(serverId);
      const mine = row?.name === name ? row : null;
      const found = snapshot.entries.get(name);
      if (found && want.entry) claimed.add(name);
      if (!want.entry) statuses[serverId] = { status: "error", reason: want.reason };
      else if (snapshot.duplicates.has(name))
        statuses[serverId] = { status: "error", reason: "duplicate" };
      else if (!found) {
        statuses[serverId] = { status: "pending" };
        actions.push({
          type: "write",
          serverId,
          name,
          entry: want.entry,
          hash: want.hash,
        });
      } else if (!mine) statuses[serverId] = { status: "name-taken" };
      else if (found.hash === want.hash) {
        statuses[serverId] = { status: "written" };
        if (mine.hash !== want.hash || mine.pendingHash)
          actions.push({ type: "settle", serverId, hash: want.hash });
      } else if (owned(mine, found)) {
        statuses[serverId] = { status: "pending" };
        actions.push({
          type: "write",
          serverId,
          name,
          entry: want.entry,
          hash: want.hash,
          expected: found.hash,
        });
      } else statuses[serverId] = { status: "conflict" };
    }
    const finds = [...snapshot.entries]
      .filter(([name]) => !claimed.has(name))
      .map(([name, found]) => ({
        name,
        entry: found.entry,
        hash: found.hash,
        duplicate: snapshot.duplicates.has(name),
      }));
    return { statuses, actions, finds };
  }

  /** The current state of `cli` without changing anything. */
  inspect(cli) {
    return this.guard(cli, () => ({ cli, ...this.plan(cli, this.read(cli)) }), false);
  }

  /** Brings `cli` in step with the bindings and reports the result. */
  reconcile(cli) {
    return this.guard(cli, () => {
      for (let attempt = 1; ; attempt++) {
        const result = this.plan(cli, this.read(cli));
        if (!result.actions.length || attempt > attempts) return { cli, ...result };
        try {
          this.apply(cli, result.actions);
        } catch (error) {
          if (error?.code !== CLI_CONFIG_CHANGED || attempt === attempts) throw error;
        }
      }
    });
  }

  /** Store first, then file: a crash in between is finished by the next run. */
  apply(cli, actions) {
    for (const action of actions) {
      if (action.type === "forget") this.entries.forget(action.serverId, cli);
      else if (action.type === "settle")
        this.entries.settle(action.serverId, cli, action.hash);
      else if (action.type === "remove") {
        this.write(cli, action.name, undefined, action.expected);
        if (!action.keep) this.entries.forget(action.serverId, cli);
      } else {
        this.entries.intend(action.serverId, cli, action.name, action.hash);
        this.write(cli, action.name, action.entry, action.expected);
        this.entries.settle(action.serverId, cli, action.hash);
      }
    }
  }

  /** Writes (or with `entry` undefined removes) `name`, if the file still holds `expected`. */
  write(cli, name, entry, expected) {
    this.edit(cli, [{ name, entry, expected }]);
  }

  /**
   * Applies `changes` (`{ name, entry, expected }`: sets `name` to `entry`, or removes it
   * when `entry` is undefined, while the file's entry hashes to `expected`) as targeted
   * edits of one file in a single compare-and-swap write: all of them land or none.
   */
  edit(cli, changes) {
    const snapshot = this.read(cli);
    for (const { name, expected } of changes)
      if (snapshot.duplicates.has(name) || snapshot.entries.get(name)?.hash !== expected)
        throw changed();
    const held = new Set(
      changes.map(({ name }) => snapshot.entries.get(name)?.config).filter(Boolean),
    );
    if (held.size > 1)
      throw Object.assign(problem(serverMessages.extensions.cliConfigLayout, 409), {
        code: CLI_CONFIG_LAYOUT,
      });
    const target = [...held][0] ?? snapshot.configs.at(-1);
    const { key, boundary } = snapshot.locations;
    try {
      let config = target;
      for (const { name, entry } of changes) {
        const data = { ...config.data, [key]: { ...(config.data[key] || {}) } };
        if (entry === undefined) delete data[key][name];
        else data[key][name] = entry;
        config = { ...config, text: editConfig(config, cli, key, name, entry), data };
      }
      if (config.text !== target.text)
        atomicText(target.file, boundary, target.text, config.text);
    } catch (error) {
      if (reasonOf(error)) throw error;
      // A problem: the file turned unsafe (linked, too large) after it was read.
      if (error?.status) throw tagged(error, "unreadable");
      if (typeof error?.syscall === "string") throw tagged(error, "write-failed");
      throw error;
    }
  }

  /** Writes AgentPier's version over the owner's edit of server `serverId`'s entry. */
  overwrite(serverId, cli) {
    const snapshot = this.read(cli);
    if (this.plan(cli, snapshot).statuses[serverId]?.status !== "conflict")
      throw problem(messages.cliNotConflict, 409);
    const want = this.desired(cli).get(serverId);
    const found = snapshot.entries.get(want.definition.name);
    this.apply(cli, [
      {
        type: "write",
        serverId,
        name: want.definition.name,
        entry: want.entry,
        hash: want.hash,
        expected: found.hash,
      },
    ]);
  }

  /** The owner's entry `from` (`{ name, hash }`) as it is now, if unchanged since read. */
  check(cli, from) {
    const snapshot = this.read(cli);
    const found = snapshot.entries.get(from.name);
    if (!found || found.hash !== from.hash || snapshot.duplicates.has(from.name))
      throw problem(messages.cliFindChanged, 409);
    return { snapshot, found };
  }

  /**
   * Takes over the owner's entry `from` (`{ name, hash }`) for server `serverId`, just
   * created from it: AgentPier's entry replaces it under the server's name, through
   * the same compare-and-swap writes as every change, only while it is unchanged since
   * the owner saw it. A new name another entry already holds is refused (409). On
   * failure the entry is restored and thrown; on success the returned function undoes
   * the takeover, for a group whose other CLIs failed.
   */
  adopt(cli, serverId, from) {
    const { snapshot, found } = this.check(cli, from);
    const want = this.desired(cli).get(serverId);
    if (!want?.entry) throw problem(messages.cliNotAdoptable, 409);
    const name = want.definition.name;
    if (name !== from.name && snapshot.entries.has(name))
      throw problem(messages.nameTaken, 409);
    const undo = () => this.restore(cli, serverId, from, found.entry, name, want.hash);
    try {
      if (name === from.name) {
        this.entries.intend(serverId, cli, name, found.hash);
        this.entries.settle(serverId, cli, found.hash);
        if (found.hash !== want.hash)
          this.apply(cli, [
            {
              type: "write",
              serverId,
              name,
              entry: want.entry,
              hash: want.hash,
              expected: found.hash,
            },
          ]);
      } else {
        // One write: the owner's entry is never gone while AgentPier's is missing.
        this.entries.intend(serverId, cli, name, want.hash);
        this.edit(cli, [
          { name, entry: want.entry, expected: undefined },
          { name: from.name, entry: undefined, expected: found.hash },
        ]);
        this.entries.settle(serverId, cli, want.hash);
      }
    } catch (error) {
      undo();
      throw error;
    }
    return undo;
  }

  /**
   * Best effort: puts the owner's `entry` back under `from.name` where AgentPier's entry
   * (`hash` under `name`) still stands, in one write per attempt, and forgets the
   * record, so whatever is in the file stays the owner's find and is never removed as
   * AgentPier's. AgentPier's entry goes only together with the restored one.
   */
  restore(cli, serverId, from, entry, name, hash) {
    for (let attempt = 1; ; attempt++) {
      try {
        const now = this.read(cli).entries;
        const ours = now.get(name)?.hash === hash;
        if (name === from.name) {
          if (ours) this.edit(cli, [{ name, entry, expected: hash }]);
        } else if (!now.has(from.name))
          this.edit(cli, [
            { name: from.name, entry, expected: undefined },
            ...(ours ? [{ name, entry: undefined, expected: hash }] : []),
          ]);
        break;
      } catch (error) {
        if (error?.code === CLI_CONFIG_CHANGED && attempt < attempts) continue;
        this.warn(
          `An adopted MCP entry for ${cli} could not be restored${codeOf(error)}.`,
        );
        break;
      }
    }
    this.entries.forget(serverId, cli);
  }

  /** The owner's entry in server `serverId`'s way in `cli` (a conflict or a taken name): `{ entry, hash }`. */
  contested(serverId, cli) {
    const snapshot = this.read(cli);
    const status = this.plan(cli, snapshot).statuses[serverId]?.status;
    if (status !== "conflict" && status !== "name-taken")
      throw problem(messages.cliNotConflict, 409);
    const { entry, hash } = snapshot.entries.get(
      this.desired(cli).get(serverId).definition.name,
    );
    return { entry, hash };
  }

  /** Records the entry under server `serverId`'s name as AgentPier's while it hashes to `hash`. */
  claim(serverId, cli, hash) {
    const want = this.desired(cli).get(serverId);
    const snapshot = want?.entry ? this.read(cli) : null;
    const found = snapshot?.entries.get(want.definition.name);
    if (!found || found.hash !== hash || snapshot.duplicates.has(want.definition.name))
      throw problem(messages.cliFindChanged, 409);
    this.entries.intend(serverId, cli, want.definition.name, hash);
    this.entries.settle(serverId, cli, hash);
  }

  /**
   * A file problem — unreadable, kept changing, not editable in place (`layout`) or
   * not writable (`write-failed`) — makes every bound server of `cli` report it, with
   * a stable reason and error code only (never a path or a value). Anything else, a
   * store error or a bug, is thrown.
   */
  guard(cli, work, loud = true) {
    try {
      return work();
    } catch (error) {
      const reason = reasonOf(error);
      if (!reason) throw error;
      if (loud)
        this.warn(
          `MCP servers for ${cli} could not be written (${reason}${codeOf(error)}).`,
        );
      const statuses = {};
      for (const serverId of this.servers.bindings("cli", cli))
        statuses[serverId] = { status: "error", reason };
      return { cli, error: reason, statuses, actions: [], finds: [] };
    }
  }
}
