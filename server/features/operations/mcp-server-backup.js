import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { mcpUrl } from "../extensions/mcp-config.js";
import { publicUrl } from "../mcp-servers/mcp-server-store.js";
import { database } from "./restore-data.js";

// The central MCP server store (docs/assistant-gateway.md, "Backups"). The public
// member is a sanitized SQLite copy: no header or environment value, no query or
// fragment in an address, no OAuth login state. The values and full addresses go
// into the passphrase capsule as `mcpValuesMember` when the backup has credentials.
export const mcpStoreMember = "mcp-servers/servers.sqlite";
export const mcpValuesMember = "mcp-server-secrets/servers.json";
// Lists the servers whose values or address the public copy withholds.
const withheldTable = "backup_withheld_values";

export const mcpServersPresent = (dataDir) =>
  fs.existsSync(path.join(dataDir, mcpStoreMember));

const tablesOf = (db) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  );

/**
 * Sanitizes a snapshot copy of the store in place (the caller vacuums it) and returns
 * what it removed: `{ version: 1, servers: [{ id, url?, secrets }] }`.
 */
export function sanitizeMcpStore(db) {
  const tables = tablesOf(db);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(servers)")
      .all()
      .map((column) => column.name),
  );
  const withheld = new Map();
  const entry = (id) => {
    if (!withheld.has(id)) withheld.set(id, { id, secrets: [] });
    return withheld.get(id);
  };
  if (tables.has("server_secrets")) {
    for (const row of db
      .prepare(
        "SELECT server_id,kind,name,value FROM server_secrets ORDER BY server_id,kind,name",
      )
      .all())
      entry(row.server_id).secrets.push({
        kind: row.kind,
        name: row.name,
        value: row.value,
      });
    db.exec("DELETE FROM server_secrets");
  }
  const strip = db.prepare("UPDATE servers SET url=? WHERE id=?");
  for (const row of db
    .prepare("SELECT id,url FROM servers WHERE url IS NOT NULL")
    .all()) {
    const shown = publicUrl(row.url) ?? null;
    if (shown === row.url) continue;
    entry(row.id).url = row.url;
    strip.run(shown, row.id);
  }
  // Logins are not backed up: a restored host starts "Not connected", and logouts
  // pending on this host mean nothing to another one.
  if (columns.has("oauth_connected")) db.exec("UPDATE servers SET oauth_connected=0");
  if (columns.has("oauth_login_redirect"))
    db.exec("UPDATE servers SET oauth_login_redirect=NULL");
  for (const table of ["oauth_logouts", "oauth_logout_history"])
    if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
  db.exec(`CREATE TABLE ${withheldTable}(server_id TEXT PRIMARY KEY)`);
  const mark = db.prepare(`INSERT INTO ${withheldTable}(server_id) VALUES (?)`);
  for (const id of withheld.keys()) mark.run(id);
  return { version: 1, servers: [...withheld.values()] };
}

const text = (value, limit) =>
  typeof value === "string" && value.length <= limit && !value.includes("\0");

/** The sealed member, checked: server id → `{ url?, secrets }`. */
function sealedValues(bytes) {
  const invalid = () => problem(serverMessages.backups.invalidMember);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw invalid();
  }
  if (value?.version !== 1 || !Array.isArray(value.servers)) throw invalid();
  const out = new Map();
  for (const server of value.servers) {
    if (!text(server?.id, 200) || out.has(server.id) || !Array.isArray(server.secrets))
      throw invalid();
    if (server.url !== undefined) {
      let valid = false;
      try {
        valid = text(server.url, 4096) && mcpUrl(server.url) === server.url;
      } catch {
        /* An address the store would refuse. */
      }
      if (!valid) throw invalid();
    }
    for (const secret of server.secrets)
      if (
        !["header", "env"].includes(secret?.kind) ||
        !text(secret.name, 1024) ||
        !secret.name ||
        !text(secret.value, 65536)
      )
        throw invalid();
    out.set(server.id, server);
  }
  return out;
}

/**
 * Completes a restored store in `stage`: writes the sealed values and addresses back
 * and returns `mcp:<name>` for every server whose values stay missing. The sealed
 * member never remains in the restored data directory.
 */
export function restoreMcpServers(stage) {
  const file = path.join(stage, mcpStoreMember);
  const sealedFile = path.join(stage, mcpValuesMember);
  try {
    const sealed = fs.existsSync(sealedFile)
      ? sealedValues(fs.readFileSync(sealedFile, "utf8"))
      : new Map();
    if (!fs.existsSync(file)) {
      if (sealed.size) throw problem(serverMessages.backups.invalidMember);
      return [];
    }
    return database(file, (db) => {
      db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
      try {
        const exists = db.prepare("SELECT 1 FROM servers WHERE id=?");
        const setUrl = db.prepare("UPDATE servers SET url=? WHERE id=?");
        const put = db.prepare(
          "INSERT OR REPLACE INTO server_secrets(server_id,kind,name,value) VALUES (?,?,?,?)",
        );
        for (const [id, server] of sealed) {
          if (!exists.get(id)) throw problem(serverMessages.backups.invalidMember);
          if (server.url !== undefined) setUrl.run(server.url, id);
          for (const s of server.secrets) put.run(id, s.kind, s.name, s.value);
        }
        const missing = tablesOf(db).has(withheldTable)
          ? db
              .prepare(
                `SELECT s.id, s.name FROM ${withheldTable} w JOIN servers s ON s.id=w.server_id ORDER BY s.name`,
              )
              .all()
              .filter((row) => !sealed.has(row.id))
              .map((row) => `mcp:${row.name}`)
          : [];
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
