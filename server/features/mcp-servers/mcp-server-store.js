import { randomUUID } from "node:crypto";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";
import { mcpUrl, record } from "../extensions/mcp-config.js";
import { PackageRecords } from "../mcp-packages/package-records.js";
import { rowPlaceholders, usesAgentPlaceholders } from "./agent-placeholders.js";
import { CliEntryStore } from "./cli-entry-store.js";
import { cleanDirectoryOrigin, readDirectoryOrigin } from "./directory-origin.js";
import { resolveCommand, sanitisedPrefix } from "./command-resolution.js";
import {
  cleanArgs,
  cleanAuth,
  cleanCwd,
  invalid,
  messages,
  publicUrl,
  splitMap,
  target,
  targetKinds,
} from "./mcp-server-fields.js";
import { inputTimeouts, publicTimeouts, rowTimeouts } from "./mcp-timeouts.js";
import { changedValues, requireLiteralValues } from "./value-references.js";
export { publicUrl } from "./mcp-server-fields.js";

const transports = ["http", "sse", "stdio"];
const schema = `
CREATE TABLE IF NOT EXISTS servers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  url TEXT, command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT,
  settings TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL,
  auth TEXT NOT NULL DEFAULT 'headers', oauth_scope TEXT,
  oauth_connected INTEGER NOT NULL DEFAULT 0, oauth_login_redirect TEXT,
  directory_origin TEXT, startup_timeout_sec INTEGER, tool_timeout_sec INTEGER);
CREATE TABLE IF NOT EXISTS server_secrets(
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('header','env')), name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(server_id, kind, name));
CREATE TABLE IF NOT EXISTS bindings(
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  PRIMARY KEY(server_id, target_kind, target_id));
CREATE INDEX IF NOT EXISTS bindings_target ON bindings(target_kind, target_id);
CREATE TABLE IF NOT EXISTS oauth_logouts(
  name TEXT NOT NULL, url TEXT NOT NULL, transport TEXT NOT NULL,
  PRIMARY KEY(name, url));
CREATE TABLE IF NOT EXISTS oauth_logout_history(
  name TEXT NOT NULL, url TEXT NOT NULL, transport TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(name, url));`;
// Columns added after the first release, in order; older databases get them on open.
const addedColumns = [
  ["auth", "TEXT NOT NULL DEFAULT 'headers'"],
  ["oauth_scope", "TEXT"],
  ["oauth_connected", "INTEGER NOT NULL DEFAULT 0"],
  ["oauth_login_redirect", "TEXT"],
  ["directory_origin", "TEXT"],
  ["startup_timeout_sec", "INTEGER"],
  ["tool_timeout_sec", "INTEGER"],
];
// Logouts remembered for a rollback to an earlier update snapshot.
const logoutHistoryLimit = 500;

/** Central MCP servers the owner binds to agents; secrets never leave `secrets()`. */
export class McpServerStore {
  constructor({ dataDir, pathEnv, exists } = {}) {
    this.resolveOptions = { pathEnv, exists };
    this.db = privateDatabase(path.join(dataDir, "mcp-servers"), "servers.sqlite");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(schema);
    // Databases from before OAuth lack its columns; their servers read as headers.
    // Those from before timeouts read as none.
    const columns = this.db.prepare("PRAGMA table_info(servers)").all();
    for (const [name, type] of addedColumns)
      if (!columns.some((c) => c.name === name))
        this.db.exec(`ALTER TABLE servers ADD COLUMN ${name} ${type}`);
    // Which native CLI entries AgentPier wrote (cli-reconciler.js).
    this.cliEntries = new CliEntryStore(this.db);
    this.packages = new PackageRecords(this.db, dataDir);
  }
  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  names(id, kind) {
    return this.db
      .prepare(
        "SELECT name FROM server_secrets WHERE server_id=? AND kind=? ORDER BY name",
      )
      .all(id, kind)
      .map((r) => r.name);
  }
  /** `{ [name]: value }` of a server's environment, for placeholder checks only. */
  envValues(id) {
    return Object.fromEntries(
      this.db
        .prepare("SELECT name,value FROM server_secrets WHERE server_id=? AND kind='env'")
        .all(id)
        .map((r) => [r.name, r.value]),
    );
  }
  placeholderFields(row) {
    return rowPlaceholders(row, row.transport === "stdio" ? this.envValues(row.id) : {});
  }
  publicServer(row, packages) {
    const origin = readDirectoryOrigin(row.directory_origin);
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      ...(row.url ? { url: publicUrl(row.url) } : {}),
      // A packaged server shows its args while its command is still pending.
      ...(row.transport === "stdio"
        ? {
            ...(row.command ? { command: row.command } : {}),
            args: JSON.parse(row.args),
          }
        : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      auth: row.auth ?? "headers",
      ...(row.oauth_scope ? { oauthScope: row.oauth_scope } : {}),
      ...publicTimeouts(rowTimeouts(row)),
      headerNames: this.names(row.id, "header"),
      envNames: this.names(row.id, "env"),
      revision: row.revision,
      ...(origin ? { directoryOrigin: origin } : {}),
      ...this.packages.publicFields(row.id, packages),
      ...this.placeholderFields(row),
    };
  }
  row(id) {
    const row = this.db.prepare("SELECT * FROM servers WHERE id=?").get(id);
    if (!row) throw problem(messages.notFound, 404);
    return row;
  }
  list() {
    const packages = this.packages.byServer();
    return this.db
      .prepare("SELECT * FROM servers ORDER BY name")
      .all()
      .map((row) => this.publicServer(row, packages));
  }
  get(id) {
    return this.publicServer(this.row(id));
  }
  /**
   * Unredacted definitions for the OpenClaw compiler, ordered by name. A row whose
   * stored arguments cannot be parsed reports `args: null` instead of throwing.
   */
  definitions() {
    const packages = this.packages.byServer();
    return this.db
      .prepare("SELECT * FROM servers ORDER BY name")
      .all()
      .map((row) => {
        let args = null;
        try {
          args = JSON.parse(row.args);
        } catch {
          /* Left to the compiler, which skips the server by name. */
        }
        return {
          id: row.id,
          name: row.name,
          transport: row.transport,
          url: row.url,
          command: row.command,
          args,
          cwd: row.cwd,
          auth: row.auth ?? "headers",
          oauthScope: row.oauth_scope ?? null,
          ...rowTimeouts(row),
          ...this.packages.definitionFields(row.id, packages, row.command),
          ...(this.placeholderFields(row).agentPlaceholders
            ? { agentPlaceholders: true }
            : {}),
        };
      });
  }
  /** `{ [targetId]: serverId[] }` for one target kind, servers ordered by name. */
  bindingsByTarget(kind) {
    if (!targetKinds.includes(kind)) throw invalid(messages.invalidTarget);
    const out = {};
    for (const r of this.db
      .prepare(
        "SELECT b.target_id, b.server_id FROM bindings b JOIN servers s ON s.id=b.server_id WHERE b.target_kind=? ORDER BY b.target_id, s.name",
      )
      .all(kind))
      (out[r.target_id] ||= []).push(r.server_id);
    return out;
  }
  close() {
    this.db.close();
  }
  secrets(id) {
    this.row(id);
    const out = { headers: {}, env: {} };
    for (const r of this.db
      .prepare("SELECT kind,name,value FROM server_secrets WHERE server_id=?")
      .all(id))
      out[r.kind === "header" ? "headers" : "env"][r.name] = r.value;
    return out;
  }
  /** Normalise a full definition (existing merged with patch) into row fields. */
  definition(input, keepCommand = false) {
    if (!record(input)) throw invalid();
    const name = sanitisedPrefix(input.name);
    if (!transports.includes(input.transport)) throw invalid(messages.invalidTransport);
    if (input.transport === "stdio") {
      if (input.url !== undefined) throw invalid();
      return {
        name,
        transport: "stdio",
        url: null,
        // node:sqlite cannot bind undefined: a pending command is stored as NULL.
        command: keepCommand
          ? (input.command ?? null)
          : resolveCommand(input.command, this.resolveOptions),
        args: cleanArgs(input.args),
        cwd: cleanCwd(input.cwd),
        ...cleanAuth(input),
        ...inputTimeouts(input),
      };
    }
    if (input.command !== undefined || input.args?.length || input.cwd) throw invalid();
    return {
      name,
      transport: input.transport,
      url: mcpUrl(input.url),
      command: null,
      args: [],
      cwd: null,
      ...cleanAuth(input),
      ...inputTimeouts(input),
    };
  }
  /**
   * The checks writeSecrets applies, without writing: an update that would fail on
   * its headers or environment fails here, before anything else happens (such as
   * an OAuth logout).
   */
  checkSecrets(id, input, transport, auth = "headers") {
    const stdio = transport === "stdio";
    if (!stdio && auth === "oauth") {
      if (
        input.env !== undefined ||
        (input.headers !== undefined &&
          !(record(input.headers) && !Object.keys(input.headers).length))
      )
        throw invalid();
      return;
    }
    if ((stdio && input.headers !== undefined) || (!stdio && input.env !== undefined))
      throw invalid();
    const kind = stdio ? "env" : "header";
    const { set, drop } = splitMap(stdio ? input.env : input.headers, !stdio);
    const rows = this.db
      .prepare("SELECT kind,name FROM server_secrets WHERE server_id=?")
      .all(id);
    const names = new Set(rows.filter((r) => r.kind === kind).map((r) => r.name));
    for (const key of drop) names.delete(key);
    for (const key of Object.keys(set)) names.add(key);
    if (rows.filter((r) => r.kind !== kind).length + names.size > 100)
      throw invalid(serverMessages.extensions.invalidEnvironmentOrHeadersObject);
  }
  writeSecrets(id, input, transport, replace, auth = "headers") {
    const stdio = transport === "stdio";
    if (!stdio && auth === "oauth") {
      // An OAuth server stores no headers; switching to OAuth drops the old ones.
      if (
        input.env !== undefined ||
        (input.headers !== undefined &&
          !(record(input.headers) && !Object.keys(input.headers).length))
      )
        throw invalid();
      this.db
        .prepare("DELETE FROM server_secrets WHERE server_id=? AND kind='header'")
        .run(id);
      return;
    }
    if ((stdio && input.headers !== undefined) || (!stdio && input.env !== undefined))
      throw invalid();
    const kind = stdio ? "env" : "header";
    const { set, drop } = splitMap(stdio ? input.env : input.headers, !stdio);
    if (replace && drop.length) throw invalid();
    const del = this.db.prepare(
      "DELETE FROM server_secrets WHERE server_id=? AND kind=? AND name=?",
    );
    for (const key of drop) del.run(id, kind, key);
    const put = this.db.prepare(
      "INSERT OR REPLACE INTO server_secrets(server_id,kind,name,value) VALUES (?,?,?,?)",
    );
    for (const [key, value] of Object.entries(set)) put.run(id, kind, key, value);
    if (
      this.db.prepare("SELECT COUNT(*) n FROM server_secrets WHERE server_id=?").get(id)
        .n > 100
    )
      throw invalid(serverMessages.extensions.invalidEnvironmentOrHeadersObject);
  }
  /** Names that differ only in case would confuse the owner and the agents' globs. */
  requireFreeName(name, id) {
    if (
      this.db
        .prepare("SELECT 1 FROM servers WHERE lower(name)=lower(?) AND id<>?")
        .get(name, id)
    )
      throw problem(messages.nameTaken, 409);
  }
  insertOrUpdate(sql, fields, id, revision) {
    this.requireFreeName(fields.name, id);
    try {
      return this.db
        .prepare(sql)
        .run(
          fields.name,
          fields.transport,
          fields.url,
          fields.command,
          JSON.stringify(fields.args),
          fields.cwd,
          fields.auth,
          fields.oauthScope,
          fields.startupTimeoutSec,
          fields.toolTimeoutSec,
          revision,
          id,
        );
    } catch (error) {
      if (/UNIQUE/.test(error.message)) throw problem(messages.nameTaken, 409);
      throw error;
    }
  }
  /**
   * `bind`: `[kind, targetId]` pairs bound in the same transaction. `pendingCommand`
   * stores a stdio server whose command a package install generates later;
   * `packageRecord` is its package source, written in the same transaction.
   */
  create(input, { bind = [], pendingCommand = false, packageRecord = null } = {}) {
    // Only a literal true leaves the command to an install; anything else needs one.
    const pending = pendingCommand === true;
    requireLiteralValues(input);
    if (pending && (input?.transport !== "stdio" || input.command !== undefined))
      throw invalid();
    if (packageRecord && !pending) throw invalid();
    const fields = this.definition(input, pending);
    const origin = cleanDirectoryOrigin(input.directoryOrigin);
    const id = randomUUID();
    this.transaction(() => {
      this.insertOrUpdate(
        "INSERT INTO servers(name,transport,url,command,args,cwd,auth,oauth_scope,startup_timeout_sec,tool_timeout_sec,revision,id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        fields,
        id,
        1,
      );
      this.writeSecrets(id, input, fields.transport, true, fields.auth);
      // Updates never touch the column: a rename or package update keeps the origin.
      if (origin)
        this.db
          .prepare("UPDATE servers SET directory_origin=? WHERE id=?")
          .run(JSON.stringify(origin), id);
      for (const [kind, targetId] of bind) this.bind(id, kind, targetId);
      if (packageRecord) this.packages.put(id, packageRecord);
    });
    return this.get(id);
  }
  /**
   * Refuses (400) a reference in what `patch` changes about server `id`; callers
   * check this before asking the owner to confirm anything. An unknown `id` is left
   * to the update itself (404).
   */
  requireLiteralPatch(id, patch) {
    const row = this.db.prepare("SELECT * FROM servers WHERE id=?").get(id);
    if (row) requireLiteralValues(changedValues(row, patch));
  }
  /** The row fields `patch` yields at `revision`; throws what update() would. */
  patched(row, revision, patch) {
    if (!Number.isSafeInteger(revision) || revision !== row.revision)
      throw problem(messages.conflict, 409);
    if (patch.transport !== undefined && patch.transport !== row.transport)
      throw invalid(messages.transportLocked);
    requireLiteralValues(changedValues(row, patch));
    const merged = {
      name: row.name,
      transport: row.transport,
      url: row.url ?? undefined,
      command: row.command ?? undefined,
      args: JSON.parse(row.args),
      cwd: row.cwd ?? undefined,
      ...(row.transport === "stdio"
        ? {}
        : { auth: row.auth ?? "headers", oauthScope: row.oauth_scope ?? undefined }),
      ...rowTimeouts(row),
      ...patch,
    };
    // The stored absolute command is only re-resolved when the owner changes it.
    const fields = this.definition(merged, patch.command === undefined);
    this.requireFreeName(fields.name, row.id);
    return fields;
  }
  /**
   * What an update would change about where OpenClaw keeps the server's OAuth login
   * (keyed by name and full URL), without writing: `{ before, after }` with `name`,
   * `url`, `auth`, `transport` and `cwd` each. Throws what update() would.
   */
  previewUpdate(id, input) {
    if (!record(input)) throw invalid();
    const { revision, ...patch } = input;
    const row = this.row(id);
    const fields = this.patched(row, revision, patch);
    this.checkSecrets(id, patch, fields.transport, fields.auth);
    const pick = (value) => ({
      name: value.name,
      url: value.url,
      auth: value.auth,
      transport: value.transport,
      cwd: value.cwd ?? null,
    });
    // The environment after the update: stored values with the patch's set and drop.
    const env = { ...this.envValues(id), ...(record(patch.env) ? patch.env : {}) };
    return {
      before: pick({ ...row, auth: row.auth ?? "headers" }),
      after: {
        ...pick(fields),
        ...(usesAgentPlaceholders(fields, env) ? { agentPlaceholders: true } : {}),
      },
    };
  }
  /**
   * What AgentPier remembers about an OAuth server's logins, never a secret:
   * whether it was ever connected and the redirect URL its last login registered.
   */
  oauthMemory(id) {
    const row = this.row(id);
    return {
      everConnected: row.oauth_connected === 1,
      loginRedirect: row.oauth_login_redirect ?? null,
    };
  }
  /** Records `{ connected?, loginRedirect? }`; the revision stays unchanged. */
  rememberOAuth(id, { connected, loginRedirect } = {}) {
    this.row(id);
    if (connected !== undefined)
      this.db
        .prepare("UPDATE servers SET oauth_connected=? WHERE id=?")
        .run(connected ? 1 : 0, id);
    if (loginRedirect !== undefined)
      this.db
        .prepare("UPDATE servers SET oauth_login_redirect=? WHERE id=?")
        .run(loginRedirect, id);
  }
  /**
   * OAuth logins OpenClaw may still hold for a name and URL no server uses any more,
   * because their logout failed. Never shown in responses.
   */
  deferredLogouts() {
    return this.db.prepare("SELECT name,url,transport FROM oauth_logouts").all();
  }
  deferLogout({ name, url, transport }) {
    this.db
      .prepare("INSERT OR IGNORE INTO oauth_logouts(name,url,transport) VALUES (?,?,?)")
      .run(name, url, transport);
  }
  /** Remembers that OpenClaw cleared the login of `{ name, url }` at `at`. */
  recordLogout({ name, url, transport }, at) {
    this.db
      .prepare(
        "INSERT INTO oauth_logout_history(name,url,transport,at) VALUES (?,?,?,?) ON CONFLICT(name,url) DO UPDATE SET at=excluded.at, transport=excluded.transport",
      )
      .run(name, url, transport ?? "http", at);
    this.db
      .prepare(
        "DELETE FROM oauth_logout_history WHERE rowid NOT IN (SELECT rowid FROM oauth_logout_history ORDER BY at DESC LIMIT ?)",
      )
      .run(logoutHistoryLimit);
  }
  /** Logins cleared at or after `at`, as `{ name, url, transport }`. */
  logoutsSince(at) {
    return this.db
      .prepare("SELECT name,url,transport FROM oauth_logout_history WHERE at>=?")
      .all(at);
  }
  settleLogout({ name, url }) {
    this.db.prepare("DELETE FROM oauth_logouts WHERE name=? AND url=?").run(name, url);
  }
  /** Updates server `id`; `clis`, when given, replaces its CLI bindings in the same write. */
  update(id, input, { clis } = {}) {
    if (!record(input)) throw invalid();
    if (clis !== undefined) this.checkClis(clis);
    const { revision, ...patch } = input;
    this.transaction(() => {
      const row = this.row(id);
      const fields = this.patched(row, revision, patch);
      this.insertOrUpdate(
        "UPDATE servers SET name=?,transport=?,url=?,command=?,args=?,cwd=?,auth=?,oauth_scope=?,startup_timeout_sec=?,tool_timeout_sec=?,revision=? WHERE id=?",
        fields,
        id,
        revision + 1,
      );
      this.writeSecrets(id, patch, fields.transport, false, fields.auth);
      if (clis !== undefined) this.replaceClis(id, clis);
    });
    return this.get(id);
  }
  remove(id) {
    this.transaction(() => {
      this.row(id);
      this.db.prepare("DELETE FROM bindings WHERE server_id=?").run(id);
      this.db.prepare("DELETE FROM server_secrets WHERE server_id=?").run(id);
      this.db.prepare("DELETE FROM servers WHERE id=?").run(id);
    });
    // Only a committed removal gets here; the hook must not throw into the caller.
    this.onRemoved?.(id);
  }
  bindings(kind, targetId) {
    target(kind, targetId);
    return this.db
      .prepare(
        "SELECT b.server_id FROM bindings b JOIN servers s ON s.id=b.server_id WHERE b.target_kind=? AND b.target_id=? ORDER BY s.name",
      )
      .all(kind, targetId)
      .map((r) => r.server_id);
  }
  bind(serverId, kind, targetId) {
    target(kind, targetId);
    this.row(serverId);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO bindings(server_id,target_kind,target_id) VALUES (?,?,?)",
      )
      .run(serverId, kind, targetId);
  }
  unbind(serverId, kind, targetId) {
    target(kind, targetId);
    this.db
      .prepare("DELETE FROM bindings WHERE server_id=? AND target_kind=? AND target_id=?")
      .run(serverId, kind, targetId);
  }
  setBindings(kind, targetId, serverIds) {
    target(kind, targetId);
    if (!Array.isArray(serverIds) || serverIds.length > 200) throw invalid();
    this.transaction(() => {
      for (const id of serverIds) this.row(id);
      this.db
        .prepare("DELETE FROM bindings WHERE target_kind=? AND target_id=?")
        .run(kind, targetId);
      for (const id of new Set(serverIds)) this.bind(id, kind, targetId);
    });
  }
  /** `{ agents, clis }`: the targets server `id` is bound to. */
  targetsOf(id) {
    const out = { agents: [], clis: [] };
    for (const r of this.db
      .prepare(
        "SELECT target_kind, target_id FROM bindings WHERE server_id=? ORDER BY target_id",
      )
      .all(id))
      out[r.target_kind === "cli" ? "clis" : "agents"].push(r.target_id);
    return out;
  }
  /** Replaces the CLI bindings of server `id` with `ids`. */
  setClis(id, ids) {
    this.checkClis(ids);
    this.transaction(() => {
      this.row(id);
      this.replaceClis(id, ids);
    });
  }
  checkClis(ids) {
    if (!Array.isArray(ids)) throw invalid();
    for (const cli of ids) target("cli", cli);
  }
  replaceClis(id, ids) {
    this.db
      .prepare("DELETE FROM bindings WHERE server_id=? AND target_kind='cli'")
      .run(id);
    for (const cli of new Set(ids)) this.bind(id, "cli", cli);
  }
}
