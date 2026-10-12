import { serverMessages } from "../../lib/i18n/de.js";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { problem } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";

const messages = serverMessages.mcpServers;

/** The store input that creates a server named `name` from a parsed native entry. */
export function adoptInput(name, { definition, secrets }) {
  if (definition.transport === "stdio")
    return {
      name,
      transport: "stdio",
      command: definition.command,
      args: definition.args,
      ...(definition.cwd ? { cwd: definition.cwd } : {}),
      env: secrets.env,
    };
  return {
    name,
    transport: definition.transport,
    url: definition.url,
    ...(definition.auth === "oauth"
      ? {
          auth: "oauth",
          ...(definition.oauthScope ? { oauthScope: definition.oauthScope } : {}),
        }
      : { headers: secrets.headers }),
  };
}

/**
 * One group as a server bound to its CLIs, its native entries now AgentPier's. All or
 * nothing: when a CLI cannot be taken over (its entry changed since the owner saw it,
 * or the file cannot be written), the CLIs already done are restored and the server
 * is removed again.
 */
function adoptGroup(servers, reconciler, group, name) {
  for (const member of group.members) reconciler.check(member.cli, member);
  const server = servers.create(adoptInput(name, group.parsed), {
    bind: group.members.map((member) => ["cli", member.cli]),
  });
  const undo = [];
  try {
    for (const member of group.members)
      undo.push(reconciler.adopt(member.cli, server.id, member));
  } catch (error) {
    for (const restore of undo.reverse()) restore();
    servers.remove(server.id);
    throw error;
  }
  return { ...server, clis: group.members.map((member) => member.cli) };
}

/**
 * Adopts finds: each chosen group becomes a server bound to the CLIs it was found in,
 * and its native entries become AgentPier's. `keys` picks groups (an unknown key means
 * the CLIs changed since the owner looked: 409); `all` takes every adoptable group and
 * reports a failing one by name instead of stopping. `names[key]` renames a group.
 */
export function adoptFinds({
  servers,
  reconciler,
  groups,
  keys = [],
  names = {},
  all = false,
}) {
  if (!record(names) || (!all && (!Array.isArray(keys) || !keys.length)))
    throw problem(messages.invalidRequest, 400);
  const chosen = all
    ? groups.filter((group) => group.parsed.ok)
    : keys.map((key) => {
        const group = groups.find((item) => item.key === key);
        if (!group) throw problem(messages.cliFindChanged, 409);
        if (!group.parsed.ok) throw problem(messages.cliNotAdoptable, 409);
        return group;
      });
  const adopted = [];
  const failed = [];
  for (const group of chosen) {
    const name =
      typeof names[group.key] === "string"
        ? names[group.key].trim()
        : (group.proposedName ?? group.name);
    try {
      adopted.push(adoptGroup(servers, reconciler, group, name));
    } catch (error) {
      if (!all) throw error;
      // Stable messages only: an unexpected error can carry a path.
      const message =
        Number.isInteger(error?.status) && error.status < 500
          ? error.message
          : messages.cliNotAdoptable;
      failed.push({
        key: group.key,
        name: group.name,
        error: message,
        ...messageIdentity(message),
      });
    }
  }
  return { adopted, failed };
}

/**
 * The update that makes `server` (public) match the owner's edit `parsed`, found in
 * `cli`. OpenCode's `remote` cannot tell SSE from HTTP, and Claude Code and Codex
 * write an OAuth server like a header server without headers: both keep the server's
 * own kind. A different connection type or settings AgentPier does not manage: 409.
 */
export function patchFromNative(server, cli, parsed) {
  if (!parsed?.ok) throw problem(messages.cliChangeNotAdoptable, 409);
  const { definition, secrets } = parsed;
  const transport =
    cli === "opencode" && server.transport === "sse" && definition.transport === "http"
      ? "sse"
      : definition.transport;
  if (transport !== server.transport) throw problem(messages.cliChangeNotAdoptable, 409);
  const replace = (names, values) => ({
    ...Object.fromEntries(
      names.filter((name) => !Object.hasOwn(values, name)).map((name) => [name, null]),
    ),
    ...values,
  });
  if (transport === "stdio")
    return {
      revision: server.revision,
      command: definition.command,
      args: definition.args,
      cwd: definition.cwd ?? "",
      env: replace(server.envNames, secrets.env),
    };
  const auth =
    definition.auth === "headers" &&
    !Object.keys(secrets.headers).length &&
    server.auth === "oauth"
      ? "oauth"
      : definition.auth;
  return {
    revision: server.revision,
    url: definition.url,
    auth,
    ...(auth === "oauth"
      ? { oauthScope: definition.oauthScope ?? "" }
      : { headers: replace(server.headerNames, secrets.headers) }),
  };
}
