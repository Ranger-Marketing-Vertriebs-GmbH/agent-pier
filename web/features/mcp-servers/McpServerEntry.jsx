import React from "react";
import McpServerDetail from "./McpServerDetail.jsx";
import McpWizard from "./wizard/McpWizard.jsx";

/** An MCP entry on Accounts: the wizard for a new server, else the saved server. */
export default function McpServerEntry(props) {
  return props.entry.kind === "mcp-new" ? (
    <McpWizard {...props} />
  ) : (
    <McpServerDetail {...props} />
  );
}
