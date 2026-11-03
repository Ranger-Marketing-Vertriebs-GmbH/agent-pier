// Claude Code's native MCP entry (docs/cli-mcp-qualification.md): `mcpServers` in
// .claude.json. It does not start a stdio command in a working directory and has no
// OAuth scope in its native form. Imports nothing: the parse helpers arrive as `shape`.

/** The native entry of a central server `entry`. */
export function toNative(entry) {
  if (entry.transport === "stdio")
    return {
      type: "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
  const oauth = entry.auth === "oauth";
  // No header map at all when there are none: then a header server without headers
  // and an OAuth server read the same in Claude Code and Codex, as they behave.
  const headers =
    !oauth && Object.keys(entry.headers || {}).length ? entry.headers : null;
  return {
    type: entry.transport === "sse" ? "sse" : "http",
    url: entry.url,
    ...(headers ? { headers } : {}),
  };
}

/** A native entry as central fields; `shape` holds the parse helpers. */
export function fromNative(entry, shape) {
  const { stdio, remote, extra, unsupported } = shape;
  const type = entry.type ?? (entry.command !== undefined ? "stdio" : undefined);
  if (type === "stdio") {
    const keys = extra(entry, ["type", "command", "args", "env"]);
    return keys.length
      ? unsupported(keys)
      : stdio(entry.command, entry.args ?? [], entry.env);
  }
  if (type === "http" || type === "sse") {
    const keys = extra(entry, ["type", "url", "headers"]);
    return keys.length ? unsupported(keys) : remote(type, entry.url, entry.headers);
  }
  return unsupported(["type"]);
}

/** Native timeout keys, in read and write order. */
export const timeouts = {
  timeout: { field: "toolTimeoutSec", scale: 1000 },
};
export const remoteSseAsHttp = false;
export const keepsOAuthScope = true;
