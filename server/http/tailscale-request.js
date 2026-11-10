// What Tailscale Serve tells AgentPier about a request it forwards from loopback.
// Serve sets these headers itself and drops any the client sent, so they describe
// the tailnet device. Every Tailscale host branch reads them here instead of keeping
// its own copy: the app (security.js) and the previews require a tailnet login, the
// machine paths (MCP, agent hooks) serve every tailnet device and refuse only Funnel.

/** Whether the request came from the public internet through Tailscale Funnel. */
export const viaFunnel = (headers) => headers["tailscale-funnel-request"] !== undefined;

/** The tailnet login of the sending device, or null (Funnel and tagged devices). */
export function tailnetLogin(headers) {
  const login = headers["tailscale-user-login"];
  return typeof login === "string" && login.trim() ? login : null;
}

/**
 * Whether a signed-in member of the own tailnet sent the request: it carries a
 * tailnet login and did not arrive through Funnel.
 */
export const fromTailnetMember = (headers) =>
  !viaFunnel(headers) && tailnetLogin(headers) !== null;
