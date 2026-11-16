/**
 * The AgentPier status of an OAuth server whose login the runtime's MCP command line
 * holds, from the state that command line reports (`authStatus`): "connected",
 * "login-pending", "login-required" or "not-connected". `pendingLogin` is true while AgentPier holds
 * an unexpired login for it; `everConnected` marks a server that was logged in
 * before (an unauthenticated one then needs a new login rather than a first one).
 */
export function oauthStatus(
  authStatus,
  { pendingLogin = false, everConnected = false } = {},
) {
  const state = authStatus?.state;
  if (state === "authorized") return "connected";
  if (pendingLogin) return "login-pending";
  if (state === "requires-authorization") return "login-required";
  // A revoked refresh token leaves pending-authorization without tokens, but with the
  // registered client. An agent turn that tried a server never logged in leaves
  // pending-authorization without a client: that server is still not connected.
  if (
    (state === "pending-authorization" || state === "unauthenticated") &&
    (everConnected || authStatus.hasClientInformation)
  )
    return "login-required";
  return "not-connected";
}
