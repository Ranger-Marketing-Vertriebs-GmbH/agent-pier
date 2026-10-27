import { ReaTool } from "../features/tools/rea-tool.js";

/**
 * Whether REA runs right now: a running coding session of a CLI its row is bound to
 * (also one that outlived an AgentPier restart in tmux), or a running agent Gateway
 * while agents have the row.
 */
export async function reaInUse({ serverId, servers, sessions, assistants }) {
  if (!serverId) return false;
  const { clis, agents } = servers.targetsOf(serverId);
  if (agents.length && assistants?.runtime?.client?.ready) return true;
  if (!clis.length) return false;
  const list = await sessions.list();
  return list.some(
    (session) => session.status === "running" && clis.includes(session.tool),
  );
}

/**
 * The managed REA tool on the central MCP server store (AGENTPIER-104), or null
 * without the store. McpPackages' install hook goes to REA, which acts for its own
 * managed row only. `services()` is read lazily: agents start after this.
 */
export function createReaTool({
  config,
  servers,
  changes,
  packages,
  extensions,
  audit,
  sessions,
  services,
}) {
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
  rea.inUse = () =>
    reaInUse({
      serverId: rea.serverId(),
      servers,
      sessions,
      assistants: services()?.assistants,
    });
  return rea;
}
