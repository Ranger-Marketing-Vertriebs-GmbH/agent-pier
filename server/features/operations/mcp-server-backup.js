import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { problem } from "../../lib/storage.js";
import { values } from "../extensions/mcp-config.js";
import { clis } from "../mcp-servers/cli-native.js";
import { readDirectoryOrigin } from "../mcp-servers/directory-origin.js";
import { publicUrl } from "../mcp-servers/mcp-server-store.js";
import { database } from "./restore-data.js";

// The central MCP server store (docs/assistant-gateway.md, "Backups"). The public
// member is a sanitized SQLite copy: no header or environment value, no query or
// fragment in an address, no OAuth login state, and no hash of a native CLI entry
// that held a withheld value. Those go into the passphrase capsule as
// `mcpValuesMember` when the backup has credentials.
export const mcpStoreMember = "mcp-servers/servers.sqlite";
export const mcpValuesMember = "mcp-server-secrets/servers.json";
// The servers whose values (`secret_values`) or address token (`address_token`) the
// public copy withholds.
const withheldTable = "backup_withheld_values";
// Everything else is dropped from the public copy, so a table or column added to
// the store later never reaches it unseen (tests/integration/mcp-server-backup-hashes).
const knownColumns = {
  servers: [
    "id",
    "name",
    "transport",
    "url",
    "command",
    "args",
    "cwd",
    "settings",
    "revision",
    "auth",
    "oauth_scope",
    "oauth_connected",
    "oauth_login_redirect",
    "directory_origin",
  ],
  server_secrets: ["server_id", "kind", "name", "value"],
  bindings: ["server_id", "target_kind", "target_id"],
  oauth_logouts: ["name", "url", "transport"],
  oauth_logout_history: ["name", "url", "transport", "at"],
  cli_entries: ["server_id", "cli", "name", "hash", "pending_hash", "written_at"],
  server_packages: [
    "server_id",
    "registry",
    "name",
    "version",
    "program",
    "program_path",
    "allow_scripts",
    "lock",
    "lock_digest",
    "integrity",
    "install_id",
    "leading_args",
    "toolchain_dir",
    "status",
    "error_code",
    "updated_at",
    "constraints",
    "needs_scripts",
  ],
};
const knownIndexes = new Set(["bindings_target"]);
// What percent-encoding can make of the 4096 characters the store accepts.
const storedUrlLimit = 3 * 4096;

/**
 * Whether the host has a store to back up. A file without any table (a crash between
 * its creation and the store's schema) holds nothing and counts as no store; one with
 * tables the sanitizer cannot use fails the backup instead.
 */
export function mcpServersPresent(dataDir) {
  const file = path.join(dataDir, mcpStoreMember);
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get();
  } finally {
    db.close();
  }
}

const schemaObjects = (db) =>
  db.prepare("SELECT type, name, sql FROM sqlite_master").all();
const tablesOf = (db) =>
  new Set(
    schemaObjects(db)
      .filter((row) => row.type === "table")
      .map((row) => row.name),
  );
const quoted = (name) => `"${name.replaceAll('"', '""')}"`;
const storeInvalid = () => problem(serverMessages.backups.invalidMcpServerStore);
// At backup time the fault lies in this host's own store, not in a backup.
const hostStoreUnusable = () => problem(serverMessages.backups.mcpServerStoreUnusable);
const valuesInvalid = () => problem(serverMessages.backups.invalidMcpServerValues);

/** Drops every view, trigger, index, table and column the store does not define. */
function keepKnownSchema(db) {
  for (const row of schemaObjects(db)) {
    if (row.type === "view" || row.type === "trigger")
      db.exec(`DROP ${row.type.toUpperCase()} IF EXISTS ${quoted(row.name)}`);
    else if (row.type === "index" && row.sql && !knownIndexes.has(row.name))
      db.exec(`DROP INDEX IF EXISTS ${quoted(row.name)}`);
  }
  for (const table of tablesOf(db)) {
    if (table.startsWith("sqlite_")) continue;
    if (!knownColumns[table]) {
      db.exec(`DROP TABLE ${quoted(table)}`);
      continue;
    }
    for (const column of db.prepare(`PRAGMA table_info(${quoted(table)})`).all())
      if (!knownColumns[table].includes(column.name))
        db.exec(`ALTER TABLE ${quoted(table)} DROP COLUMN ${quoted(column.name)}`);
  }
}

/**
 * Sanitizes a snapshot copy of the store in place (the caller vacuums it) and returns
 * what it removed: `{ version: 1, servers: [{ id, url?, secrets }], cliEntries }`.
 */
export function sanitizeMcpStore(db) {
  try {
    keepKnownSchema(db);
  } catch {
    // For example an unknown column inside a key, which SQLite cannot drop.
    throw hostStoreUnusable();
  }
  const tables = tablesOf(db);
  if (!tables.has("servers")) throw hostStoreUnusable();
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(servers)")
      .all()
      .map((column) => column.name),
  );
  const withheld = new Map();
  const entry = (id) => {
    if (!withheld.has(id))
      withheld.set(id, { id, secrets: [], secretValues: false, addressToken: false });
    return withheld.get(id);
  };
  if (tables.has("server_secrets")) {
    for (const row of db
      .prepare(
        "SELECT server_id,kind,name,value FROM server_secrets ORDER BY server_id,kind,name",
      )
      .all()) {
      const server = entry(row.server_id);
      server.secretValues = true;
      server.secrets.push({ kind: row.kind, name: row.name, value: row.value });
    }
    db.exec("DELETE FROM server_secrets");
  }
  const strip = db.prepare("UPDATE servers SET url=? WHERE id=?");
  for (const row of db
    .prepare("SELECT id,url FROM servers WHERE url IS NOT NULL")
    .all()) {
    const shown = publicUrl(row.url) ?? null;
    if (shown === row.url) continue;
    Object.assign(entry(row.id), { url: row.url, addressToken: true });
    strip.run(shown, row.id);
  }
  // Logins are not backed up: a restored host starts "Not connected", and logouts
  // pending on this host mean nothing to another one. `settings` is unused.
  if (columns.has("oauth_connected")) db.exec("UPDATE servers SET oauth_connected=0");
  if (columns.has("oauth_login_redirect"))
    db.exec("UPDATE servers SET oauth_login_redirect=NULL");
  if (columns.has("settings")) db.exec("UPDATE servers SET settings='{}'");
  for (const table of ["oauth_logouts", "oauth_logout_history"])
    if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
  // An entry hash is an unsalted SHA-256 over the native entry, values included:
  // public, it would let anyone test guesses of a short value. The records of
  // withheld and deleted servers are sealed with the values instead.
  const cliEntries = [];
  if (tables.has("cli_entries")) {
    const known = new Set(
      db
        .prepare("SELECT id FROM servers")
        .all()
        .map((row) => row.id),
    );
    const forget = db.prepare("DELETE FROM cli_entries WHERE server_id=? AND cli=?");
    for (const row of db
      .prepare("SELECT * FROM cli_entries ORDER BY server_id,cli")
      .all())
      if (!known.has(row.server_id) || withheld.has(row.server_id)) {
        cliEntries.push({
          serverId: row.server_id,
          cli: row.cli,
          name: row.name,
          hash: row.hash,
          pendingHash: row.pending_hash,
          writtenAt: row.written_at,
        });
        forget.run(row.server_id, row.cli);
      }
  }
  db.exec(
    `CREATE TABLE ${withheldTable}(server_id TEXT PRIMARY KEY, secret_values INTEGER NOT NULL, address_token INTEGER NOT NULL)`,
  );
  const mark = db.prepare(`INSERT INTO ${withheldTable} VALUES (?,?,?)`);
  for (const server of withheld.values())
    mark.run(server.id, server.secretValues ? 1 : 0, server.addressToken ? 1 : 0);
  return {
    version: 1,
    servers: [...withheld.values()].map(({ id, url, secrets }) => ({
      id,
      ...(url !== undefined ? { url } : {}),
      secrets,
    })),
    cliEntries,
  };
}

const text = (value, limit) =>
  typeof value === "string" && value.length <= limit && !value.includes("\0");
const optionalText = (value, limit) => value === null || text(value, limit);

/** Whether `value` is an address the store could hold; otherwise it is reported. */
function storedUrl(value) {
  if (!text(value, storedUrlLimit) || /[\x00-\x1f\x7f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.href === value &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** The sealed member, checked with the store's own rules; any fault refuses it. */
function sealedValues(bytes) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw valuesInvalid();
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.servers) ||
    !Array.isArray(value.cliEntries ?? [])
  )
    throw valuesInvalid();
  const servers = new Map();
  for (const server of value.servers) {
    if (
      !text(server?.id, 200) ||
      servers.has(server.id) ||
      !Array.isArray(server.secrets)
    )
      throw valuesInvalid();
    // Null-prototype maps: a name like `__proto__` must reach `values()` as a key.
    const maps = { header: Object.create(null), env: Object.create(null) };
    for (const secret of server.secrets) {
      const map = maps[secret?.kind];
      if (
        !map ||
        typeof secret.name !== "string" ||
        typeof secret.value !== "string" ||
        Object.hasOwn(map, secret.name)
      )
        throw valuesInvalid();
      map[secret.name] = secret.value;
    }
    try {
      values(maps.header, true);
      values(maps.env, false);
    } catch {
      throw valuesInvalid();
    }
    if (server.secrets.length > 100) throw valuesInvalid();
    servers.set(server.id, server);
  }
  const entries = value.cliEntries ?? [];
  for (const entry of entries)
    if (
      !text(entry?.serverId, 200) ||
      !clis.includes(entry.cli) ||
      !text(entry.name, 1024) ||
      !optionalText(entry.hash ?? null, 128) ||
      !optionalText(entry.pendingHash ?? null, 128) ||
      !(entry.writtenAt == null || Number.isSafeInteger(entry.writtenAt))
    )
      throw valuesInvalid();
  return { servers, entries };
}

/** Writes the sealed values into the restored store; returns the restored addresses. */
function applySealed(db, tables, sealed) {
  if (
    !tables.has("server_secrets") ||
    (sealed.entries.length && !tables.has("cli_entries"))
  )
    throw storeInvalid();
  const exists = db.prepare("SELECT 1 FROM servers WHERE id=?");
  const setUrl = db.prepare("UPDATE servers SET url=? WHERE id=?");
  const put = db.prepare(
    "INSERT OR REPLACE INTO server_secrets(server_id,kind,name,value) VALUES (?,?,?,?)",
  );
  const addresses = new Set();
  for (const [id, server] of sealed.servers) {
    if (!exists.get(id)) throw valuesInvalid();
    if (server.url !== undefined && storedUrl(server.url)) {
      setUrl.run(server.url, id);
      addresses.add(id);
    }
    for (const s of server.secrets) put.run(id, s.kind, s.name, s.value);
  }
  if (!sealed.entries.length) return addresses;
  const record = db.prepare(
    "INSERT OR REPLACE INTO cli_entries(server_id,cli,name,hash,pending_hash,written_at) VALUES (?,?,?,?,?,?)",
  );
  for (const e of sealed.entries)
    record.run(
      e.serverId,
      e.cli,
      e.name,
      e.hash ?? null,
      e.pendingHash ?? null,
      e.writtenAt ?? null,
    );
  return addresses;
}

/**
 * Completes a restored store in `stage`: writes the sealed values, addresses and CLI
 * entry records back and returns `mcp:<name>` (values) and `mcp-address:<name>`
 * (address token) for what stays missing. The sealed member never remains in the
 * restored data directory.
 */
/** A crafted backup's directory origin that would not validate becomes NULL. */
function dropInvalidOrigins(db) {
  const columns = db.prepare("PRAGMA table_info(servers)").all();
  if (!columns.some((column) => column.name === "directory_origin")) return;
  const clear = db.prepare("UPDATE servers SET directory_origin=NULL WHERE id=?");
  for (const row of db
    .prepare(
      "SELECT id, directory_origin FROM servers WHERE directory_origin IS NOT NULL",
    )
    .all())
    if (!readDirectoryOrigin(row.directory_origin)) clear.run(row.id);
}

export function restoreMcpServers(stage) {
  const file = path.join(stage, mcpStoreMember);
  const sealedFile = path.join(stage, mcpValuesMember);
  try {
    const sealed = fs.existsSync(sealedFile)
      ? sealedValues(fs.readFileSync(sealedFile, "utf8"))
      : null;
    if (!fs.existsSync(file)) {
      if (sealed) throw storeInvalid();
      return [];
    }
    return database(file, (db) => {
      const tables = tablesOf(db);
      if (!tables.has("servers")) throw storeInvalid();
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try {
        const addresses = sealed ? applySealed(db, tables, sealed) : new Set();
        dropInvalidOrigins(db);
        const restored = sealed?.servers ?? new Map();
        const missing = [];
        if (tables.has(withheldTable)) {
          const forget = tables.has("cli_entries")
            ? db.prepare("DELETE FROM cli_entries WHERE server_id=?")
            : null;
          for (const row of db
            .prepare(
              `SELECT s.id, s.name, w.secret_values, w.address_token FROM ${withheldTable} w JOIN servers s ON s.id=w.server_id ORDER BY s.name`,
            )
            .all()) {
            const noValues = row.secret_values === 1 && !restored.has(row.id);
            const noAddress = row.address_token === 1 && !addresses.has(row.id);
            if (noValues) missing.push(`mcp:${row.name}`);
            if (noAddress) missing.push(`mcp-address:${row.name}`);
            // A native entry recorded as AgentPier's would be rewritten without the
            // missing part: it becomes the owner's, to adopt (docs/assistant-gateway.md).
            if ((noValues || noAddress) && forget) forget.run(row.id);
          }
        }
        db.exec(`DROP TABLE IF EXISTS ${withheldTable}; COMMIT`);
        return missing;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  } finally {
    fs.rmSync(path.dirname(sealedFile), { recursive: true, force: true });
  }
}
