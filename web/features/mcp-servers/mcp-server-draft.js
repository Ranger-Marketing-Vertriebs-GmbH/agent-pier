// Form state for one MCP server and the request bodies built from it.
let counter = 0;
const nextKey = () => `row-${++counter}`;
const lines = (text) => text.split("\n").filter((line) => line !== "");
/** Dependency constraints of a PyPI source: one per line, blank lines dropped. */
export const constraintLines = (text = "") =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
/** Only PyPI sources carry constraints (D4); npm sends none. */
export const sourceConstraints = (registry, text) =>
  registry === "pypi" ? { constraints: constraintLines(text) } : {};

/** Stored entries show their names only; their values never reach the browser. */
const storedRows = (names = []) =>
  names.map((name) => ({
    key: nextKey(),
    name,
    value: "",
    stored: true,
    removed: false,
  }));

/**
 * Only a switch to a ready install replaces the stored command: before it (installing,
 * failed, choosing) a server switched from an own command still runs that one.
 */
const ownCommand = (server) =>
  !server?.source || ["installing", "failed", "choosing"].includes(server.source.status);

export function draftFrom(server) {
  return {
    name: server?.name || "",
    transport: server?.transport || "http",
    url: server?.url || "",
    command: ownCommand(server) ? server?.command || "" : "",
    // A packaged server shows the owner's arguments only; the server reports
    // leadingArgs 0 until a first install stored a generated argument.
    args: (server?.args || []).slice(server?.source?.leadingArgs ?? 0).join("\n"),
    cwd: server?.cwd || "",
    auth: server?.auth === "oauth" ? "oauth" : "headers",
    oauthScope: server?.oauthScope || "",
    headers: storedRows(server?.headerNames),
    env: storedRows(server?.envNames),
    source: server?.source ? "package" : "command",
    registry: server?.source?.registry || "npm",
    packageName: server?.source?.name || "",
    packageVersion: server?.source?.version || "",
    allowScripts: server?.source?.allowScripts === true,
    packageConstraints: (server?.source?.constraints || []).join("\n"),
  };
}

/** The fields "Keep package" restores: the package source and the stored owner args. */
export function keepPackageValues(server) {
  const stored = draftFrom(server);
  return { source: "package", command: stored.command, args: stored.args };
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
  const packaged = stdio && draft.source === "package";
  const packageSource = () => ({
    registry: draft.registry,
    name: draft.packageName.trim(),
    version: draft.packageVersion,
    allowScripts: draft.allowScripts === true,
    ...sourceConstraints(draft.registry, draft.packageConstraints),
  });
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
            ...(packaged
              ? { source: packageSource() }
              : { command: draft.command.trim() }),
            args: lines(draft.args),
            ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
          }
        : { url: draft.url.trim() }),
      ...(oauth ? { auth: "oauth", ...(scope ? { oauthScope: scope } : {}) } : {}),
      ...(Object.keys(secrets).length ? { [secretKey]: secrets } : {}),
    };
  const original = draftFrom(server);
  const changed = (key) => draft[key].trim() !== original[key].trim();
  // A packaged server switched back to an own command (`source: null`) always sends
  // its args: the stored ones still start with the generated program path.
  const detach = stdio && !!server.source && !packaged;
  return {
    revision: server.revision,
    ...(changed("name") ? { name: draft.name.trim() } : {}),
    ...(stdio
      ? {
          // An own-command server switching to a package (D1): its source, never a
          // command; a packaged server's source changes only through its update.
          ...(packaged && !server.source ? { source: packageSource() } : {}),
          ...(detach ? { source: null, command: draft.command.trim() } : {}),
          ...(!packaged && !detach && changed("command")
            ? { command: draft.command.trim() }
            : {}),
          ...(detach || draft.args !== original.args ? { args: lines(draft.args) } : {}),
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
