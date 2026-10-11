import React from "react";
import { locale } from "../../lib/i18n/index.js";
import { mcpOAuthCopy as copy } from "../../lib/i18n/messages/mcp-oauth.js";

const statuses = new Set([
  "connected",
  "login-required",
  "login-pending",
  "not-connected",
  "logout-pending",
  "unknown",
]);

/** Whether the server signs in with OAuth (remote servers only). */
export const usesOAuth = (server) =>
  server?.auth === "oauth" && server.transport !== "stdio";

/**
 * The server's login status: a held login that is still being removed reads
 * "logout-pending"; anything the browser does not know reads "unknown".
 */
export function oauthStatusOf(server) {
  if (server.oauthReason?.code === "logout-pending") return "logout-pending";
  return statuses.has(server.oauthStatus) ? server.oauthStatus : "unknown";
}

const expiry = (at) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
};

/** The login status badge of an OAuth server. */
export default function McpOAuthStatus({ server }) {
  const status = oauthStatusOf(server);
  return (
    <span
      className={`mcp-badge mcp-oauth-status mcp-oauth-${status}`}
      title={copy.statusLabel(copy.statuses[status])}
    >
      {copy.statuses[status]}
    </span>
  );
}

/** What the status means for the owner: the token's expiry or why it is unknown. */
export function McpOAuthStatusHint({ server }) {
  const status = oauthStatusOf(server);
  if (status === "connected" && server.oauthExpiresAt) {
    const time = expiry(server.oauthExpiresAt);
    return time ? <p className="mcp-hint">{copy.expires(time)}</p> : null;
  }
  if (status === "logout-pending")
    return <p className="mcp-hint">{copy.logoutPendingHint}</p>;
  if (status === "unknown") return <p className="mcp-hint">{copy.unknownHint}</p>;
  return null;
}
