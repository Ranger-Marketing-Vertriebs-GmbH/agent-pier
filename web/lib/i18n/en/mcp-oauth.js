/** English counterpart of de/mcp-oauth.js with identical keys. */
export const mcpOAuthCopy = {
  authLabel: "Authentication",
  auths: {
    headers: "Headers (token)",
    oauth: "OAuth",
  },
  oauthHint:
    "After saving, use “Log in” in the server list. The provider must support automatic client registration; otherwise put a token in the headers if the provider accepts one, or use an MCP package of the server.",
  oauthEditHint:
    "Changing the name or address, or switching to headers, removes the current OAuth login.",
  advanced: "Advanced",
  scopeLabel: "OAuth scope (optional)",
  scopeHint: "Space-separated scopes, only if the provider needs specific ones.",
  switchTitle: "Switch to OAuth?",
  switchWarning: (names) =>
    `OAuth uses no headers. Saving deletes the stored headers ${names}; they cannot be restored.`,
  switchConfirm: "Delete headers and save",
  authDetail: "Authentication",
  scopeDetail: "Scope",
  statuses: {
    connected: "Connected",
    "login-required": "Login required",
    "login-pending": "Login in progress",
    "not-connected": "Not connected",
    "logout-pending": "Removing old login",
    unknown: "Status unknown",
  },
  expires: (time) => `Access valid until ${time}; it renews automatically.`,
  logoutPendingHint:
    "The previous login is still being removed. Until then the server is not active; logging in removes it first.",
  logoutDeferred:
    "Saved. The previous OAuth login could not be removed right now; AgentPier retries in the background.",
  unknownHint:
    "The login status cannot be read right now, for example while the agent runtime is not running.",
  statusLabel: (status) => `Login status: ${status}`,
  login: "Log in",
  loginNamed: (name) => `Log in to ${name}`,
  loggingIn: "Opening login …",
  logout: "Log out",
  logoutNamed: (name) => `Log out of ${name}`,
  loggingOut: "Logging out …",
  loggedOut: (name) => `Logged out of ${name}.`,
  alreadyConnected: (name) => `${name} is already connected.`,
  invalidAuthorizationUrl: "The login address is invalid.",
  originBlocked:
    "OAuth logins cannot start from the address you opened AgentPier with. Servers with headers are not affected.",
  connected: (name) =>
    `Logged in to ${name}. Agents bound to it can use its tools from their next turn.`,
  failed: (name) => `The login to ${name} failed.`,
  failedUnnamed: "The OAuth login failed.",
  thisServer: "the server",
  dismiss: "Dismiss",
  reasons: {
    access_denied: "Access was denied at the provider.",
    invalid_request: "The provider rejected the login request.",
    invalid_scope:
      "The provider rejected the requested scope. Check the scope in the server's advanced settings.",
    unauthorized_client: "The provider does not allow this client to log in.",
    unsupported_response_type: "The provider does not support this kind of login.",
    server_error: "The provider reported an internal error. Try again later.",
    temporarily_unavailable: "The provider is temporarily unavailable. Try again later.",
    "provider-error": "The provider reported an error.",
    "code-missing": "The provider returned no login code. Start the login again.",
    "invalid-code": "The provider returned an invalid login code. Start the login again.",
    "invalid-name": "This server name cannot be used for a login.",
    "url-missing": "OpenClaw returned no login address. Please try again.",
    "cli-timeout": "Completing the login took too long. Please try again.",
    "no-dynamic-registration":
      "This provider does not support automatic client registration. It needs a pre-registered client or a client metadata document, which AgentPier cannot set up yet. If the provider offers this server as an MCP package, for example with an API key, add the package instead.",
    "resource-mismatch":
      "The provider gives a different address for this server. Enter the provider's address for the server and start the login again.",
    "redirect-rejected": (redirect) =>
      `The provider rejected the redirect address ${redirect}.`,
    "session-missing": "The login session is no longer valid. Start the login again.",
    "runtime-unavailable": "The agent runtime is not available.",
    "server-unknown":
      "The server is not active yet. Assign it to an agent and wait until the agent runtime is running.",
    "cli-failed": "Completing the login failed. Please try again.",
    unavailable:
      "AgentPier could not complete the login right now, for example during a backup or restore. Start the login again.",
    "state-invalid":
      "This login has expired, was already used or was replaced, for example by a newer login or a restart of AgentPier. Start the login again.",
    "plain-http-remote":
      "OAuth logins need HTTPS or the AgentPier host itself. Open AgentPier through Tailscale (HTTPS) or directly on the AgentPier host.",
    unknown: "The login could not be completed. Please try again.",
  },
  agentLoginHint: "Log in to OAuth servers under Connections › MCP servers.",
};
