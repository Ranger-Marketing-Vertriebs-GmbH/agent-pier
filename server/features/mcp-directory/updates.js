import { normalizePypiName } from "../mcp-packages/package-spec.js";
import { comparePep440 } from "../mcp-packages/pep440.js";
import { compareSemver } from "../mcp-packages/registry-metadata.js";
import { publicUrl } from "../mcp-servers/mcp-server-fields.js";

// "Update available" for servers set up from the directory (decisions Q8, Q9): only a
// newer exact version of the same package. A changed identifier or address is a hint.
const sameName = (registry, a, b) =>
  registry === "pypi" ? normalizePypiName(a) === normalizePypiName(b) : a === b;
const newer = (registry, candidate, installed) => {
  try {
    return (
      (registry === "pypi" ? comparePep440 : compareSemver)(candidate, installed) > 0
    );
  } catch {
    return false;
  }
};

export function directoryUpdate(server, entry) {
  if (!server?.directoryOrigin || !Array.isArray(entry?.options)) return null;
  const { source } = server;
  if (source) {
    const options = entry.options.filter((option) => option.kind === source.registry);
    const same = options.find((option) =>
      sameName(source.registry, option.identifier, source.name),
    );
    if (same)
      return newer(source.registry, same.version, source.version)
        ? { serverId: server.id, version: same.version }
        : null;
    return options.length ? { serverId: server.id, hint: "identifier" } : null;
  }
  if (server.transport !== "stdio" && server.url) {
    // A template address ({var}) never equals a stored one; it is not compared.
    // The store shows an address without its query and in URL-normalised form.
    const remotes = entry.options.filter(
      (option) => option.kind?.startsWith("remote-") && !option.urlVariables?.length,
    );
    if (remotes.length && !remotes.some((option) => publicUrl(option.url) === server.url))
      return { serverId: server.id, hint: "remote" };
  }
  return null;
}

/** Asks the directory for at most `limit` servers, `parallel` at a time. */
export async function directoryUpdates({ servers, detail, limit = 20, parallel = 4 }) {
  const queue = servers.filter((server) => server.directoryOrigin).slice(0, limit);
  const updates = [];
  const worker = async () => {
    for (let server = queue.shift(); server; server = queue.shift()) {
      try {
        const update = directoryUpdate(server, await detail(server.directoryOrigin.name));
        if (update) updates.push(update);
      } catch {
        // One unreachable entry hides only its own pill.
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return updates.sort((a, b) => a.serverId.localeCompare(b.serverId));
}
