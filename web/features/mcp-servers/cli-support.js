// Mirrors cliSupport in server/features/mcp-servers/cli-native.js so the form can
// explain a disabled CLI; the server decides (400 MCP_CLI_*_UNSUPPORTED).
import { cliDefinition, codingCliIds } from "../../../server/features/clis/catalog.js";
export const clis = codingCliIds().sort();
// `agentPlaceholders`: the server (or the draft, see cliTarget) uses agent
// placeholders, which no CLI gets (MCP_CLI_PLACEHOLDER_UNSUPPORTED).
export function cliSupport(cli, server) {
  if (server.agentPlaceholders === true)
    return { supported: false, reason: "placeholder" };
  const { mcpSse, mcpStdioCwd } = cliDefinition(cli).capabilities;
  if (!mcpSse && server.transport === "sse")
    return { supported: false, reason: "transport" };
  if (!mcpStdioCwd && server.transport === "stdio" && server.cwd)
    return { supported: false, reason: "cwd" };
  return { supported: true };
}

/** What cliSupport needs of a saved server. */
export const cliTarget = (server) => ({
  transport: server.transport,
  cwd: server.cwd || "",
  agentPlaceholders: server.agentPlaceholders === true,
});
