// Form state for one MCP server and the request bodies built from it.
let counter = 0;
const nextKey = () => `row-${++counter}`;
const lines = (text) => text.split("\n").filter((line) => line !== "");

/** Stored entries show their names only; their values never reach the browser. */
const storedRows = (names = []) =>
  names.map((name) => ({
    key: nextKey(),
    name,
    value: "",
    stored: true,
    removed: false,
  }));

export function draftFrom(server) {
  return {
    name: server?.name || "",
    transport: server?.transport || "http",
    url: server?.url || "",
    command: server?.command || "",
    args: (server?.args || []).join("\n"),
    cwd: server?.cwd || "",
    auth: server?.auth === "oauth" ? "oauth" : "headers",
    oauthScope: server?.oauthScope || "",
    headers: storedRows(server?.headerNames),
    env: storedRows(server?.envNames),
  };
}

/** `{ Name: "value" }` for new and replaced entries, `{ Name: null }` for removed ones. */
function secretMap(rows) {
  const map = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.removed) map[name] = null;
    else if (row.value) map[name] = row.value;
  }
  return map;
}

/** An existing header server switching to OAuth loses its stored headers. */
export function dropsStoredHeaders(draft, server) {
  return (
    !!server &&
    draft.transport !== "stdio" &&
    server.auth !== "oauth" &&
    draft.auth === "oauth" &&
    (server.headerNames || []).length > 0
  );
}

/**
 * The create body, or for an existing server the revision plus only what the owner
 * changed: the address is sent only when edited (the shown one has no query string).
 * An OAuth server sends no headers; its optional scope replaces them.
 */
export function requestBody(draft, server) {
  const stdio = draft.transport === "stdio";
  const oauth = !stdio && draft.auth === "oauth";
  const secrets = oauth ? {} : secretMap(stdio ? draft.env : draft.headers);
  const secretKey = stdio ? "env" : "headers";
  const scope = draft.oauthScope.trim();
  if (!server)
    return {
      name: draft.name.trim(),
      transport: draft.transport,
      ...(stdio
        ? {
            command: draft.command.trim(),
            args: lines(draft.args),
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          }
        : { url: draft.url.trim() }),
      ...(oauth ? { auth: "oauth", ...(scope ? { oauthScope: scope } : {}) } : {}),
      ...(Object.keys(secrets).length ? { [secretKey]: secrets } : {}),
    };
  const original = draftFrom(server);
  const changed = (key) => draft[key].trim() !== original[key].trim();
  return {
    revision: server.revision,
    ...(changed("name") ? { name: draft.name.trim() } : {}),
    ...(stdio
      ? {
          ...(changed("command") ? { command: draft.command.trim() } : {}),
          ...(draft.args !== original.args ? { args: lines(draft.args) } : {}),
          ...(changed("cwd") ? { cwd: draft.cwd.trim() } : {}),
        }
      : {
          ...(changed("url") ? { url: draft.url.trim() } : {}),
          ...(draft.auth !== original.auth ? { auth: draft.auth } : {}),
          ...(oauth && (changed("oauthScope") || draft.auth !== original.auth)
            ? { oauthScope: scope }
            : {}),
        }),
    ...(Object.keys(secrets).length ? { [secretKey]: secrets } : {}),
  };
}
