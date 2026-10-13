import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";

/** A saved change's notices: a pending apply and a deferred OAuth logout. */
export const savedNotice = (saved) =>
  [
    saved?.pending ? copy.pendingNotice : "",
    saved?.oauthWarning?.code === "oauth-logout-deferred"
      ? mcpOAuthCopy.logoutDeferred
      : "",
  ]
    .filter(Boolean)
    .join(" ");
