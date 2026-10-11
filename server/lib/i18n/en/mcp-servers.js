/** English counterpart of de/mcp-servers.js with identical keys. */
export const mcpServers = Object.freeze({
  invalidName:
    "Enter a server name of 1 to 30 letters, digits, underscores or hyphens, starting with a letter.",
  nameTaken: "This server name is already in use.",
  invalidTransport: "Choose HTTP, SSE or stdio as the connection.",
  transportLocked: "A server's connection type cannot be changed.",
  invalidCwd: "Enter an absolute working directory.",
  commandNotFound:
    "The command was not found or is not executable. Enter an installed command or an absolute path.",
  invalidTarget: "This target does not support MCP servers.",
  invalidRequest: "Invalid request for MCP servers.",
  notFound: "MCP server not found.",
  conflict: "The MCP server changed in the meantime. Reload and try again.",
  stdioConfirmationRequired:
    "A stdio server runs a command with your rights and without a sandbox. Please confirm.",
  agentNotEligible:
    "MCP servers cannot be assigned to this agent: temporary team members receive them through the team approval, archived agents not at all.",
});
