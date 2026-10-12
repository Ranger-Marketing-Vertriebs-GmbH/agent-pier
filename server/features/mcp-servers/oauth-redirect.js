// The redirect URL OpenClaw registers by DCR for MCP OAuth (see
// docs/mcp-oauth-qualification.md). It must stay stable: a changed URL means a new
// client registration at every authorization server.
export const oauthCallbackPath = "/api/mcp-servers/oauth/callback";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

const parse = (value) => {
  try {
    return typeof value === "string" && value ? new URL(value) : null;
  } catch {
    return null;
  }
};

/** The HTTPS origin of `remoteUrl`, or null when it is unset, malformed or plain HTTP. */
function httpsOrigin(remoteUrl) {
  const url = parse(remoteUrl);
  return url?.protocol === "https:" ? url.origin : null;
}

/**
 * The stable redirect URL MCP OAuth servers are compiled with: the HTTPS remote
 * origin when one is configured, else AgentPier's own loopback listener.
 */
export function oauthRedirect({ remoteUrl, port }) {
  const origin = httpsOrigin(remoteUrl) || `http://127.0.0.1:${port}`;
  return `${origin}${oauthCallbackPath}`;
}

// Where a brokered coding-CLI login (Codex) returns to. Codex appends a path segment
// of its own per server URL; the callback is routed by `state` (codex-mcp-logins.js).
export const cliOAuthCallbackPath = "/api/mcp-servers/cli-oauth/callback";

/** The callback URL a brokered Codex login is started with (same origin rule as above). */
export function cliOAuthCallback({ remoteUrl, port }) {
  const origin = httpsOrigin(remoteUrl) || `http://127.0.0.1:${port}`;
  return `${origin}${cliOAuthCallbackPath}`;
}

/**
 * Whether a login started from `requestOrigin` can complete: the browser must reach
 * the redirect URL. A plain-HTTP network origin never can (reason
 * "plain-http-remote"); a remote browser cannot reach a loopback redirect (reason
 * "loopback-redirect").
 */
export function oauthLoginUsable({ requestOrigin, remoteUrl }) {
  const request = parse(requestOrigin);
  const loopback = !!request && loopbackHosts.has(request.hostname);
  if (!request || (request.protocol !== "https:" && !loopback))
    return { usable: false, reason: "plain-http-remote" };
  if (!loopback && !httpsOrigin(remoteUrl))
    return { usable: false, reason: "loopback-redirect" };
  return { usable: true, reason: null };
}
