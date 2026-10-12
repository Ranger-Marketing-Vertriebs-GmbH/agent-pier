import { createHash } from "node:crypto";
import { mcpUrl } from "../extensions/mcp-config.js";
import { namePattern } from "./command-resolution.js";
import { centralFromNative, clis, contentKey, proposeName } from "./cli-native.js";
import { publicUrl } from "./mcp-server-store.js";

const headerless = ({ ok, definition, secrets }) =>
  ok &&
  definition.transport !== "stdio" &&
  definition.auth === "headers" &&
  !Object.keys(secrets.headers).length;

/**
 * What two finds must share to be one server. The URL is compared normalised (a
 * trailing slash or letter case of the host does not matter). Claude Code and Codex
 * write an OAuth server without a scope like a remote server without headers, so the
 * two compare equal; a scope or a header keeps them apart.
 */
function groupKey(parsed) {
  const definition = { ...parsed.definition };
  if (definition.url) definition.url = mcpUrl(definition.url);
  if (headerless(parsed)) definition.auth = "oauth";
  return contentKey({ definition, secrets: parsed.secrets });
}

/**
 * The owner's own entries in all CLIs (`results`: cli → reconciler result) as groups
 * to adopt. The same name with the same content in several CLIs is one group, which
 * becomes one server bound to each of them; anything else stays separate. A merged
 * group adopts as OAuth when any of its entries says so. A name that is invalid or
 * already used centrally gets a proposal, assigned in CLI order and clear of the
 * other finds' names. Groups hold values and never leave the server; `publicFind` is
 * what responses show.
 */
export function groupFinds(results, centralNames) {
  const groups = new Map();
  const found = new Set();
  for (const cli of clis)
    for (const find of results[cli]?.finds || []) {
      found.add(find.name.toLowerCase());
      const parsed = find.duplicate
        ? { ok: false, reason: "duplicate" }
        : centralFromNative(cli, find.entry);
      const id = parsed.ok ? `${find.name}\0${groupKey(parsed)}` : `${cli}\0${find.name}`;
      if (!groups.has(id)) groups.set(id, { name: find.name, parsed, members: [] });
      const group = groups.get(id);
      if (headerless(group.parsed) && parsed.definition?.auth === "oauth")
        group.parsed = parsed;
      group.members.push({ cli, name: find.name, hash: find.hash });
    }
  const taken = new Set(centralNames.map((name) => name.toLowerCase()));
  return [...groups.values()].map((group) => {
    // The key changes with any member's content: a stale page cannot adopt an edit.
    const key = createHash("sha256")
      .update(JSON.stringify(group.members))
      .digest("hex")
      .slice(0, 32);
    if (!group.parsed.ok) return { key, ...group };
    const free = namePattern.test(group.name) && !taken.has(group.name.toLowerCase());
    const name = free
      ? group.name
      : proposeName(group.name, new Set([...taken, ...found]));
    taken.add(name.toLowerCase());
    return { key, ...group, ...(free ? {} : { proposedName: name }) };
  });
}

/** A find as responses show it: header and environment names, never a value. */
export function publicFind(group) {
  const base = {
    key: group.key,
    name: group.name,
    clis: group.members.map((member) => member.cli),
    adoptable: group.parsed.ok,
  };
  if (!group.parsed.ok) return { ...base, reason: group.parsed.reason };
  const { definition, secrets } = group.parsed;
  return {
    ...base,
    ...(group.proposedName ? { proposedName: group.proposedName } : {}),
    transport: definition.transport,
    auth: definition.auth,
    ...(definition.url ? { url: publicUrl(definition.url) } : {}),
    ...(definition.command ? { command: definition.command } : {}),
    headerNames: Object.keys(secrets.headers).sort(),
    envNames: Object.keys(secrets.env).sort(),
  };
}
