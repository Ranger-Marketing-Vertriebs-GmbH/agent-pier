import React from "react";
import { mcpCliCopy as copy } from "../../lib/i18n/messages/mcp-cli.js";
import { ExtensionHint } from "./ExtensionTable.jsx";
import ExtensionsFrame from "./ExtensionsFrame.jsx";

/**
 * MCP servers are managed in the central list (Accounts → MCP servers). The frame
 * keeps the profile's sharing import and notices on this, the default, tab.
 */
export default function McpTab({ ext, account, request, hideError }) {
  return (
    <ExtensionsFrame {...{ ext, account, request, hideError }}>
      <ExtensionHint>
        <p>{copy.extensionsMoved}</p>
      </ExtensionHint>
    </ExtensionsFrame>
  );
}
