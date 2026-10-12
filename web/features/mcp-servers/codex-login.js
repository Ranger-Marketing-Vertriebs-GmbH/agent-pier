// Brokered MCP logins in AgentPier-managed Codex accounts (server/http/routes/
// mcp-cli-oauth.js): the address check, the login tab and the result texts.
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a login can start from `location`. Mirrors oauthLoginUsable
 * (server/features/mcp-servers/oauth-redirect.js): a plain-HTTP network address never
 * can; the server decides the rest.
 */
export const brokerUsable = (location) =>
  location.protocol === "https:" || loopbackHosts.has(location.hostname);

/** Why a login failed, in words: Codex's own reasons, then the provider's. */
export function failureReason(reason) {
  const key = typeof reason === "string" ? reason : "";
  if (Object.hasOwn(copy.codexReasons, key)) return copy.codexReasons[key];
  const shared = Object.hasOwn(mcpOAuthCopy.reasons, key)
    ? mcpOAuthCopy.reasons[key]
    : null;
  return typeof shared === "string" ? shared : mcpOAuthCopy.reasons.unknown;
}

/**
 * Opens an empty tab while the click still counts as the owner's action (popup
 * blockers, Safari), cut off from this page so the provider cannot reach it. Null
 * when the browser refused.
 */
export function openBlankTab(open = window.open.bind(window)) {
  const tab = open("", "_blank");
  if (tab) tab.opener = null;
  return tab;
}

/** The callback's result for a Codex account: who logged in where, and why it failed. */
export function codexResultText(result, servers) {
  const server = (servers || []).find((item) => item.id === result.serverId);
  const account = server?.cliStatus?.codex?.oauth?.accounts?.find(
    (item) => item.id === result.accountId,
  )?.name;
  const name = server?.name || mcpOAuthCopy.thisServer;
  // Before the list loaded the account is not known yet: a neutral sentence.
  if (result.result === "connected")
    return account
      ? copy.codexConnected(account, name)
      : copy.codexConnectedUnnamed(name);
  const failed = account
    ? copy.codexFailed(account, name)
    : copy.codexFailedUnnamed(name);
  return `${failed} ${failureReason(result.reason)}`;
}
