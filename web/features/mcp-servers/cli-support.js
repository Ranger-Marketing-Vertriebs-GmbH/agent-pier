// Mirrors cliSupport in server/features/mcp-servers/cli-native.js so the form can
// explain a disabled CLI; the server decides (400 MCP_CLI_*_UNSUPPORTED).
export const clis = ["claude", "codex", "opencode"];
export function cliSupport(cli, server) {
  if (cli === "codex" && server.transport === "sse")
    return { supported: false, reason: "transport" };
  if (cli === "claude" && server.transport === "stdio" && server.cwd)
    return { supported: false, reason: "cwd" };
  return { supported: true };
}
