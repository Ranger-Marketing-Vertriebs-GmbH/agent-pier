import React from "react";
import { mcpOAuthCopy } from "../../lib/i18n/messages/mcp-oauth.js";

// What the last MCP action reported: an address that cannot start OAuth logins and
// the notice of a login, logout, save or removal.
export default function McpFeedback({ oauth, notice }) {
  return (
    <>
      {oauth?.originBlocked && (
        <p role="status" className="mcp-notice">
          {mcpOAuthCopy.originBlocked}
        </p>
      )}
      {notice && (
        <p role="status" className="mcp-hint">
          {notice}
        </p>
      )}
    </>
  );
}
