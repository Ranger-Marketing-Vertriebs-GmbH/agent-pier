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
  oauthRateLimited: "Too many OAuth logins and logouts. Please try again in a minute.",
  oauthLogoutPending:
    "The previous login is still being removed. Until then the server is not active.",
  cliNotConflict: "This entry in the CLI is no longer in conflict. Please reload.",
  cliFindChanged: "The entry in the CLI changed since it was shown. Please reload.",
  cliNotAdoptable:
    "AgentPier cannot take over this entry without losing settings it does not manage.",
  cliFindEnvReferences:
    "The entry uses references to environment variables or files (${…}, {env:…}, {file:…}). Another CLI or an agent would read them differently, so it stays in the CLI.",
  cliChangeEnvReferences:
    "The change uses references to environment variables or files (${…}, {env:…}, {file:…}). Another CLI or an agent would read them differently, so it cannot be adopted.",
  valueReference:
    "AgentPier stores values literally. The CLIs would each resolve references such as ${…}, {env:…} or {file:…} differently, and agents not at all; enter the value itself.",
  cliChangeNotAdoptable:
    "The change cannot be adopted: its connection type differs or it uses settings AgentPier does not manage.",
  cliTransportUnsupported:
    "This coding CLI does not support the server's connection type.",
  cliCwdUnsupported:
    "This coding CLI cannot start a local command in a working directory. Remove the working directory or choose only Codex or OpenCode.",
  cliStatusConflict:
    "The entry was edited by hand in the CLI. Write AgentPier's version or adopt the change.",
  cliStatusNameTaken:
    "The CLI already has its own entry with this name. Adopt it to let AgentPier manage it.",
  cliReasonUnreadable: "The CLI's configuration cannot be read.",
  cliReasonTooLarge:
    "The CLI's configuration is larger than 64 MiB; AgentPier does not read or change it.",
  cliReasonChanged:
    "The CLI's configuration kept changing and could not be written. Please try again later.",
  cliReasonLayout:
    "The CLI's configuration cannot be edited in place without changing other entries.",
  cliReasonWriteFailed: "The CLI's configuration cannot be written.",
  cliReasonFailed:
    "The MCP servers of this CLI could not be prepared. AgentPier tries again at the next session start.",
  cliReasonInvalid: "This coding CLI cannot take the server as it is.",
  cliReasonDuplicate:
    "The CLI lists this name more than once. Please remove one of the entries in the CLI.",
  cliLoginNotBound:
    "The server is not assigned to Codex. Select Codex among the server's coding CLIs.",
  cliLoginAccountInvalid:
    "AgentPier logs in only in Codex accounts it manages. In your own Codex profile run codex mcp login in a terminal.",
  cliLoginCodexMissing: "Logging in needs Codex installed on the AgentPier host.",
  cliLoginLimit: "Too many Codex logins are open. Complete or cancel one and try again.",
  cliLoginPrepareFailed:
    "The Codex account could not be prepared. Try again once no plugin action is running.",
  cliLoginFailed: "Codex could not start the login. Please try again.",
});
