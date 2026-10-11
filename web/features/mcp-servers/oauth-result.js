// The result of an MCP OAuth login: the callback redirects to the Accounts page with
// `oauth` (connected or error), `server` (its id) and an optional stable `reason`.
// The route keeps it while the address is normalized to a plain /accounts.
import { mcpOAuthCopy as copy } from "../../lib/i18n/messages/mcp-oauth.js";

const results = new Set(["connected", "error"]);
const serverId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const reasonCode = /^[a-z][a-z_-]{0,63}$/;

/** `{ mcpOAuth: { result, serverId?, reason? } }` from a query string, or `{}`. */
export function readMcpOAuthResult(search) {
  const query = new URLSearchParams(search);
  const result = query.get("oauth");
  if (!results.has(result)) return {};
  const server = query.get("server") || "";
  const reason = query.get("reason") || "";
  return {
    mcpOAuth: {
      result,
      ...(serverId.test(server) ? { serverId: server } : {}),
      ...(result === "error" && reasonCode.test(reason) ? { reason } : {}),
    },
  };
}

/** Only web addresses are opened for a login, never script or data URLs. */
export function authorizationTarget(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/** The callback address the provider sent the browser to: this page's origin. */
export const callbackAddress = (origin) => `${origin}/api/mcp-servers/oauth/callback`;

/** The callback's result text: who it was for, and why it failed. */
export function oauthResultText(result, servers, origin) {
  const name = (servers || []).find((s) => s.id === result.serverId)?.name;
  if (result.result === "connected") return copy.connected(name || copy.thisServer);
  const reason = Object.hasOwn(copy.reasons, result.reason || "")
    ? copy.reasons[result.reason]
    : copy.reasons.unknown;
  const why = typeof reason === "function" ? reason(callbackAddress(origin)) : reason;
  return `${name ? copy.failed(name) : copy.failedUnnamed} ${why}`;
}
