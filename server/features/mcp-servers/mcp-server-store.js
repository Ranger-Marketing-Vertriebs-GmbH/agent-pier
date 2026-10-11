import { randomUUID } from "node:crypto";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";
import { mcpUrl, record, values } from "../extensions/mcp-config.js";
import { resolveCommand, sanitisedPrefix } from "./command-resolution.js";

const messages = serverMessages.mcpServers;
const transports = ["http", "sse", "stdio"];
const targetKinds = ["agent"];
const schema = `
CREATE TABLE IF NOT EXISTS servers(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  url TEXT, command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT,
  settings TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS server_secrets(
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('header','env')), name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(server_id, kind, name));
CREATE TABLE IF NOT EXISTS bindings(
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  PRIMARY KEY(server_id, target_kind, target_id));
CREATE INDEX IF NOT EXISTS bindings_target ON bindings(target_kind, target_id);`;

const invalid = (message = messages.invalidRequest) => problem(message);
const target = (kind, id) => {
  if (!targetKinds.includes(kind)) throw invalid(messages.invalidTarget);
  if (typeof id !== "string" || !id || id.length > 200 || /[\x00-\x1f]/.test(id))
    throw invalid(messages.invalidTarget);
};
function cleanArgs(value = []) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((a) => typeof a !== "string" || a.length > 16384 || a.includes("\0"))
  )
    throw invalid(serverMessages.extensions.invalidArgumentList);
  return value;
}
function cleanCwd(value) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !path.isAbsolute(value)
  )
    throw invalid(messages.invalidCwd);
  return value;
}
/** Split a patch map into values to set and names to remove (`null`). */
function splitMap(input, headers) {
  if (input === undefined) return { set: {}, drop: [] };
  if (!record(input))
    throw invalid(serverMessages.extensions.invalidEnvironmentOrHeadersObject);
  const set = {};
  const drop = [];
  for (const [key, value] of Object.entries(input))
    if (value === null) drop.push(key);
    else set[key] = value;
  values(set, headers);
  values(Object.fromEntries(drop.map((k) => [k, ""])), headers);
  return { set, drop };
}

/** Central MCP servers the owner binds to agents; secrets never leave `secrets()`. */
export class McpServerStore {
  constructor({ dataDir, pathEnv, exists } = {}) {
    this.resolveOptions = { pathEnv, exists };
    this.db = privateDatabase(path.join(dataDir, "mcp-servers"), "servers.sqlite");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(schema);
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
  publicServer(row) {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      ...(row.url ? { url: row.url } : {}),
      ...(row.command ? { command: row.command, args: JSON.parse(row.args) } : {}),
      ...(row.cwd ? { cwd: row.cwd } : {}),
      headerNames: this.names(row.id, "header"),
      envNames: this.names(row.id, "env"),
      revision: row.revision,
    };
  }
  row(id) {
    const row = this.db.prepare("SELECT * FROM servers WHERE id=?").get(id);
    if (!row) throw problem(messages.notFound, 404);
    return row;
  }
  list() {
    return this.db
      .prepare("SELECT * FROM servers ORDER BY name")
      .all()
      .map((row) => this.publicServer(row));
  }
  get(id) {
    return this.publicServer(this.row(id));
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
        command: keepCommand
          ? input.command
          : resolveCommand(input.command, this.resolveOptions),
        args: cleanArgs(input.args),
        cwd: cleanCwd(input.cwd),
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
    };
  }
  writeSecrets(id, input, transport, replace) {
    const stdio = transport === "stdio";
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
  insertOrUpdate(sql, fields, id, revision) {
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
          revision,
          id,
        );
    } catch (error) {
      if (/UNIQUE/.test(error.message)) throw problem(messages.nameTaken, 409);
      throw error;
    }
  }
  create(input) {
    const fields = this.definition(input);
    const id = randomUUID();
    this.transaction(() => {
      this.insertOrUpdate(
        "INSERT INTO servers(name,transport,url,command,args,cwd,revision,id) VALUES (?,?,?,?,?,?,?,?)",
        fields,
        id,
        1,
      );
      this.writeSecrets(id, input, fields.transport, true);
    });
    return this.get(id);
  }
  update(id, input) {
    if (!record(input)) throw invalid();
    const { revision, ...patch } = input;
    this.transaction(() => {
      const row = this.row(id);
      if (!Number.isSafeInteger(revision) || revision !== row.revision)
        throw problem(messages.conflict, 409);
      if (patch.transport !== undefined && patch.transport !== row.transport)
        throw invalid(messages.transportLocked);
      const merged = {
        name: row.name,
        transport: row.transport,
        url: row.url ?? undefined,
        command: row.command ?? undefined,
        args: JSON.parse(row.args),
        cwd: row.cwd ?? undefined,
        ...patch,
      };
      // The stored absolute command is only re-resolved when the owner changes it.
      const fields = this.definition(merged, patch.command === undefined);
      this.insertOrUpdate(
        "UPDATE servers SET name=?,transport=?,url=?,command=?,args=?,cwd=?,revision=? WHERE id=?",
        fields,
        id,
        revision + 1,
      );
      this.writeSecrets(id, patch, fields.transport, false);
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
}
