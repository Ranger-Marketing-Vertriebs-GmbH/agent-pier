import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { invalid, messages } from "./mcp-server-fields.js";

const schema = `
CREATE TABLE IF NOT EXISTS managed_servers(
  server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  tool TEXT NOT NULL, locked_env TEXT NOT NULL DEFAULT '[]');`;
// What only the tool that manages a row may change; the owner keeps the rest.
const lockedFields = ["name", "command", "args", "cwd", "transport", "source"];

/** The stored names; anything but a JSON list reads as none, non-strings drop out. */
function parsedNames(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}
function cleanNames(names) {
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
    throw invalid();
  return [...new Set(names)];
}

/**
 * MCP server rows a tool of AgentPier (such as REA) set up and keeps: which tool,
 * and the environment names it writes. A marker goes with its row (ON DELETE
 * CASCADE); the generic MCP routes refuse to change what it locks.
 */
export class ManagedServers {
  constructor(db) {
    this.db = db;
    db.exec(schema);
  }
  get(serverId) {
    const row = this.db
      .prepare("SELECT tool, locked_env FROM managed_servers WHERE server_id=?")
      .get(serverId);
    return row ? { tool: row.tool, lockedEnv: parsedNames(row.locked_env) } : null;
  }
  /** Marks row `serverId` as managed by `tool`; callers write it with the row. */
  put(serverId, { tool, lockedEnv = [] } = {}) {
    if (typeof tool !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(tool)) throw invalid();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO managed_servers(server_id,tool,locked_env) VALUES (?,?,?)",
      )
      .run(serverId, tool, JSON.stringify(cleanNames(lockedEnv)));
  }
  setLockedEnv(serverId, names) {
    this.db
      .prepare("UPDATE managed_servers SET locked_env=? WHERE server_id=?")
      .run(JSON.stringify(cleanNames(names)), serverId);
  }
  /** The id of the row `tool` manages, or null. */
  byTool(tool) {
    return (
      this.db
        .prepare("SELECT server_id FROM managed_servers WHERE tool=? ORDER BY server_id")
        .get(tool)?.server_id ?? null
    );
  }
  publicFields(serverId) {
    const managed = this.get(serverId);
    return managed ? { managed } : {};
  }
}

const markerOf = (servers, id) => servers?.managed?.get(id) ?? null;

/**
 * Refuses (409) an owner change to managed row `id` that touches what its tool keeps:
 * name, command, args, cwd, transport, package source or one of its environment
 * names. Own environment names, timeouts and bindings stay the owner's.
 */
export function requireOwnerPatch(servers, id, patch) {
  const managed = markerOf(servers, id);
  if (!managed || !record(patch)) return;
  const env = record(patch.env) ? Object.keys(patch.env) : [];
  if (
    lockedFields.some((field) => Object.hasOwn(patch, field)) ||
    env.some((name) => managed.lockedEnv.includes(name))
  )
    throw problem(messages.managedLocked, 409);
}

/** Refuses (409) to remove a managed row through anything but its tool. */
export function requireUnmanaged(servers, id) {
  if (markerOf(servers, id)) throw problem(messages.managedRemoveThroughTool, 409);
}
