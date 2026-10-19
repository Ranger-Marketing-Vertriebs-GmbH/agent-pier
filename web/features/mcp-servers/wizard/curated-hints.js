// Notes AgentPier adds to specific MCP servers: pitfalls their listing does not tell.
// A note is keyed by the exact registry name and the exact package (registry and
// name), never by a prefix, a case-folded or a similar name, so a look-alike entry or
// package gets none. Registry names under io.github.* are verified against the GitHub
// account; npm package names are unique. The copy lives in the mcp-directory catalogs
// under `curated.hints.<id>`.
const curated = [
  {
    id: "rea",
    serverName: "io.github.morluto/rea",
    packages: [{ registry: "npm", name: "rea-agents" }],
  },
];

const byServer = new Map(curated.map((item) => [item.serverName, item.id]));
const byPackage = new Map(
  curated.flatMap((item) =>
    item.packages.map((pkg) => [`${pkg.registry}:${pkg.name}`, item.id]),
  ),
);

/** The curated hint id for a registry entry or a package, or null. */
export function curatedHintFor({ serverName, registry, packageName } = {}) {
  if (typeof serverName === "string" && byServer.has(serverName))
    return byServer.get(serverName);
  if (typeof registry !== "string" || typeof packageName !== "string") return null;
  return byPackage.get(`${registry}:${packageName.trim()}`) ?? null;
}
