// OpenCode's native MCP entry (docs/cli-mcp-qualification.md): `mcp` in opencode.json.
// Its `remote` cannot tell SSE from HTTP. Imports nothing: the parse helpers arrive as
// `shape`.

/** The native entry of a central server `entry`. */
export function toNative(entry) {
  if (entry.transport === "stdio")
    return {
      type: "local",
      command: [entry.command, ...entry.args],
      environment: entry.env,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      enabled: true,
    };
  const oauth = entry.auth === "oauth";
  const headers =
    !oauth && Object.keys(entry.headers || {}).length ? entry.headers : null;
  return {
    type: "remote",
    url: entry.url,
    ...(oauth
      ? { oauth: entry.oauthScope ? { scope: entry.oauthScope } : {} }
      : headers
        ? { headers }
        : {}),
    enabled: true,
  };
}

/** A native entry as central fields; `shape` holds the parse helpers. */
export function fromNative(entry, shape) {
  const { stdio, remote, extra, record, unsupported, fail } = shape;
  if (entry.enabled === false) return unsupported(["enabled"]);
  if (entry.type === "local") {
    const keys = extra(entry, ["type", "command", "environment", "cwd", "enabled"]);
    if (keys.length) return unsupported(keys);
    if (!Array.isArray(entry.command) || !entry.command.length) fail();
    const [command, ...args] = entry.command;
    return stdio(command, args, entry.environment, entry.cwd ?? null);
  }
  if (entry.type !== "remote") return unsupported(["type"]);
  const keys = extra(entry, ["type", "url", "headers", "oauth", "enabled"]);
  if (keys.length) return unsupported(keys);
  if (entry.oauth === undefined) return remote("http", entry.url, entry.headers);
  if (!record(entry.oauth) || extra(entry.oauth, ["scope"]).length || entry.headers)
    return unsupported(["oauth"]);
  if (entry.oauth.scope !== undefined && typeof entry.oauth.scope !== "string") fail();
  return remote("http", entry.url, {}, entry.oauth.scope ?? "");
}

/** Native timeout keys, in read and write order. */
export const timeouts = {
  timeout: { field: "toolTimeoutSec", scale: 1000 },
};
export const remoteSseAsHttp = true;
export const keepsOAuthScope = false;
