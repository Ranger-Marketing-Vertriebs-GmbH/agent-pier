import fs from "node:fs";
import path from "node:path";

// The MCP keys of the shared CLI documents (Claude Code, Codex, OpenCode).
const mcpKeys = ["mcpServers", "mcp_servers", "mcp"];

/** Whether `dir` is an AgentPier data directory: its account list and server store. */
function isDataDir(dir) {
  try {
    return (
      fs.statSync(path.join(dir, "accounts.json")).isFile() &&
      fs.statSync(path.join(dir, "mcp-servers", "servers.sqlite")).isFile()
    );
  } catch {
    return false;
  }
}

/** Every absolute path among the string values of `value`, a few levels deep. */
function paths(value, out = [], depth = 0) {
  if (typeof value === "string") {
    if (path.isAbsolute(value)) out.push(path.resolve(value));
  } else if (value && typeof value === "object" && depth < 4)
    for (const item of Object.values(value)) paths(item, out, depth + 1);
  return out;
}

/**
 * The other AgentPier data directory that MCP `entry` runs from or points into (its
 * command, arguments, working directory or environment), or null. Paths inside
 * `ownDataDir` are this instance's own and never count.
 */
export function foreignDataDir(entry, ownDataDir) {
  const own = path.resolve(ownDataDir);
  const seen = new Map();
  for (const start of paths(entry)) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (dir === own) break;
      if (!seen.has(dir)) seen.set(dir, isDataDir(dir));
      if (seen.get(dir)) return dir;
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

/**
 * The shared `values` of a CLI profile without the MCP entries of another AgentPier
 * instance (`foreignDataDir`). Another instance's managed REA or Craft Anything entry,
 * found in the owner's home profile, would otherwise reach this instance's managed
 * accounts and run with that instance's data; it stays only where the owner wrote it.
 * With `canonical` (the canonical profile's values) such an entry becomes the one the
 * canonical profile holds under its name, or is left out: a managed account's copy is
 * never imported, and never removed from the canonical profile either.
 */
export function withoutForeignEntries(values, ownDataDir, canonical = null) {
  let result = values;
  for (const key of mcpKeys) {
    const entries = values[key];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    const fallback = canonical?.[key] || {};
    let changed = false;
    const kept = {};
    for (const [name, entry] of Object.entries(entries)) {
      if (!foreignDataDir(entry, ownDataDir)) kept[name] = entry;
      else {
        changed = true;
        if (Object.hasOwn(fallback, name)) kept[name] = fallback[name];
      }
    }
    if (changed) result = { ...result, [key]: kept };
  }
  return result;
}
