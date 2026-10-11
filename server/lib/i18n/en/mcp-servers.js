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
  oauthNotOAuth: "This server does not sign in with OAuth.",
  oauthNotCompiled:
    "The server is not active yet. Assign it to an agent and wait until the assistant runtime is running.",
  oauthPlainHttpRemote:
    "OAuth needs HTTPS or the AgentPier host itself. Open AgentPier through Tailscale (HTTPS) or directly on the AgentPier host.",
  oauthLoopbackRedirect:
    "The login returns to the local address of the AgentPier host. Open AgentPier directly on that host or set up Tailscale (HTTPS).",
  oauthStateInvalid:
    "This login has expired, was replaced or is unknown. Start the login again.",
  oauthNoDynamicRegistration:
    "This provider does not support automatic client registration. Use a token in the headers instead.",
  oauthRedirectRejected: (redirect) =>
    `The provider rejected the redirect address ${redirect}.`,
  oauthSessionMissing: "The login session is no longer valid. Start the login again.",
  oauthCliTimeout: "The login did not answer in time. Please try again.",
  oauthRuntimeUnavailable: "The assistant runtime is not available.",
  oauthLoginFailed: "The OAuth login failed. Please try again.",
  oauthLogoutFailed: "The server's OAuth login could not be removed. Please try again.",
  oauthLogoutDeferred:
    "Saved. The previous OAuth login could not be removed right now; AgentPier keeps retrying in the background. Until then a server with the same name and address stays inactive.",
  oauthLogoutPending:
    "The previous login is still being removed. Until then the server is not active.",
});
