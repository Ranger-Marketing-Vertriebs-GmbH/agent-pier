// Codex's native MCP entry (docs/cli-mcp-qualification.md): `[mcp_servers.<name>]` in
// config.toml. No SSE. A stdio command starts in its working directory. An OAuth server
// carries no headers, only its scopes; the login runs with `codex mcp login`.
// Imports nothing: the parse helpers arrive as `shape`.

/** The native entry of a central server `entry`. */
export function toNative(entry) {
  if (entry.transport === "stdio")
    return {
      command: entry.command,
      args: entry.args,
      env: entry.env,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
    };
  const oauth = entry.auth === "oauth";
  // No header map at all when there are none: then a header server without headers
  // and an OAuth server read the same in Claude Code and Codex, as they behave.
  const headers =
    !oauth && Object.keys(entry.headers || {}).length ? entry.headers : null;
  if (!oauth) return { url: entry.url, ...(headers ? { http_headers: headers } : {}) };
  const scopes = (entry.oauthScope || "").split(/\s+/).filter(Boolean);
  return { url: entry.url, ...(scopes.length ? { scopes } : {}) };
}

/** A native entry as central fields; `shape` holds the parse helpers. */
export function fromNative(entry, shape) {
  const { stdio, remote, extra, strings, unsupported } = shape;
  if (entry.enabled === false) return unsupported(["enabled"]);
  if (entry.command !== undefined) {
    const keys = extra(entry, ["command", "args", "env", "cwd", "enabled"]);
    return keys.length
      ? unsupported(keys)
      : stdio(entry.command, entry.args ?? [], entry.env, entry.cwd ?? null);
  }
  const keys = extra(entry, ["url", "http_headers", "scopes", "enabled"]);
  if (keys.length) return unsupported(keys);
  if (entry.scopes === undefined) return remote("http", entry.url, entry.http_headers);
  if (!strings(entry.scopes) || !entry.scopes.length || entry.http_headers !== undefined)
    return unsupported(["scopes"]);
  return remote("http", entry.url, {}, entry.scopes.join(" "));
}

/** Native timeout keys, in read and write order. */
export const timeouts = {
  startup_timeout_sec: { field: "startupTimeoutSec", scale: 1 },
  tool_timeout_sec: { field: "toolTimeoutSec", scale: 1 },
};
export const remoteSseAsHttp = false;
export const keepsOAuthScope = false;
