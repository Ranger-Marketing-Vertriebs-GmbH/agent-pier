import { ReaTool } from "../features/tools/rea-tool.js";

/**
 * The managed REA tool on the central MCP server store (AGENTPIER-104), or null
 * without the store. McpPackages' install hook goes to REA, which acts for its own
 * managed row only.
 */
export function createReaTool({ config, servers, changes, packages, extensions, audit }) {
  if (!servers || !packages) return null;
  const rea = new ReaTool({
    dataDir: config.dataDir,
    servers,
    changes,
    packages,
    extensions,
    audit,
  });
  packages.afterInstall = (serverId, context) => rea.afterInstall(serverId, context);
  // No inUse hook: AgentPier sees no call in flight of a session's REA, and an idle
  // one keeps its version folder until it exits, so nothing blocks a change.
  return rea;
}
