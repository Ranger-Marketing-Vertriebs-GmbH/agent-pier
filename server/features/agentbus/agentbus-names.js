// The names AgentBus goes by in a session: the MCP server, the Claude Code plugin
// that carries it (agent-bus.js) and the tools that only read. The default approval
// list (requests/cli-approval-defaults.js) builds its tool names from the same
// values, so renaming the plugin or the server cannot leave that list stale.
export const agentBusServerName = "agentpier_agentbus";
export const agentBusPluginName = "agentpier-agentbus";

// `peers_list` lists the reachable sessions of the project; `inbox_read` fetches
// this session's own unread messages and marks them fetched. `peer_send` writes
// to another session and is not among them.
export const agentBusReadTools = Object.freeze(["peers_list", "inbox_read"]);

/**
 * A tool of the AgentBus plugin as Claude Code names it in a permission request:
 * `mcp__plugin_<plugin>_<server>__<tool>` for the MCP server of a plugin.
 */
export const claudeAgentBusTool = (tool) =>
  `mcp__plugin_${agentBusPluginName}_${agentBusServerName}__${tool}`;
