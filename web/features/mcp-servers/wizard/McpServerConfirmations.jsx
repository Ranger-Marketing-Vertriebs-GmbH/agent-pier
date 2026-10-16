import React from "react";
import { OAuthSwitchConfirmation } from "../McpAuthFields.jsx";
import McpPackageConfirmation from "../McpPackageConfirmation.jsx";
import StdioConfirmation from "../StdioConfirmation.jsx";

/** The save chain's open question for an edit step, below its form. */
export default function McpServerConfirmations({ server, draft, programChoice }) {
  const confirmation = draft.confirmation;
  if (!confirmation) return null;
  if (confirmation.kind === "oauthSwitch")
    return (
      <OAuthSwitchConfirmation
        names={server.headerNames}
        busy={false}
        onConfirm={confirmation.confirm}
        onCancel={confirmation.cancel}
      />
    );
  if (confirmation.kind === "package")
    return (
      <McpPackageConfirmation
        preview={confirmation.data.preview}
        allowScripts={draft.values.allowScripts}
        returnKey="mcp-form-save"
        onConfirm={(program) => {
          programChoice.current = program ?? null;
          confirmation.confirm();
        }}
        onCancel={confirmation.cancel}
      />
    );
  if (confirmation.kind === "stdio" || confirmation.kind === "cliStdio")
    return (
      <StdioConfirmation
        cli={confirmation.kind === "cliStdio"}
        returnKey="mcp-form-save"
        busy={false}
        onConfirm={confirmation.confirm}
        onCancel={confirmation.cancel}
      />
    );
  return null;
}
