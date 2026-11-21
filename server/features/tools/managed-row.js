import { profileLocation, readShared } from "../cli-profiles/configuration.js";

/**
 * The MCP entry names `clis` hold in their native profiles: the canonical profile
 * (`local-<cli>`) and every managed account's own copy, which the shared-profile sync
 * merges into it. A profile that cannot be read adds nothing.
 */
export function nativeEntryNames(extensions, clis) {
  const names = new Set();
  const add = (entries) => {
    for (const name of Object.keys(entries || {})) names.add(name.toLowerCase());
  };
  for (const cli of clis) {
    let key = null;
    try {
      const locations = extensions.locations(`local-${cli}`);
      key = locations.key;
      for (const config of extensions.configs(locations)) add(config.data[key]);
    } catch {
      continue;
    }
    const accounts = extensions.accounts;
    for (const account of accounts.list())
      if (account.tool === cli && account.kind === "managed")
        try {
          add(readShared(profileLocation(accounts, account.id))[key]);
        } catch {
          // An unreadable managed profile only cannot add its names.
        }
  }
  return names;
}

/**
 * A free name for a managed tool's new row (`tool`'s `servers` and `extensions`):
 * `base`, else `<base>-agentpier`, else `<base>-agentpier-<n>`. A name is taken by a
 * central server or by any entry in the native profiles of `clis`, the CLIs the row is
 * bound to, so AgentPier never writes over or next to an entry of the same name.
 */
export function managedRowName({ servers, extensions }, base, clis) {
  const taken = nativeEntryNames(extensions, clis);
  for (const server of servers.list()) taken.add(server.name.toLowerCase());
  let name = taken.has(base) ? `${base}-agentpier` : base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-agentpier-${n}`;
  return name;
}

/**
 * The first CLI binding of row `id` that is not in effect (`{ cli, status, reason,
 * messageKey }`), through the tool's `cliTrouble` hook (CliMcpBindings.trouble), or
 * null. Never throws: the card then shows no binding error.
 */
export function rowTrouble(tool, id) {
  if (!id || !tool.cliTrouble) return null;
  try {
    return tool.cliTrouble(id) ?? null;
  } catch {
    return null;
  }
}
