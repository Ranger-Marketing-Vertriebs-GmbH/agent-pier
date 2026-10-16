import React from "react";
import EditConnectStep from "./wizard/EditConnectStep.jsx";
import EditSettingsStep from "./wizard/EditSettingsStep.jsx";
import EditSetupStep from "./wizard/EditSetupStep.jsx";
import McpServerOverview from "./wizard/McpServerOverview.jsx";
import McpWizard from "./wizard/McpWizard.jsx";

const editSteps = {
  setup: EditSetupStep,
  settings: EditSettingsStep,
  connect: EditConnectStep,
};

/** An MCP entry on Accounts: the wizard, a saved server's overview or one edit step. */
export default function McpServerEntry(props) {
  if (props.entry.kind === "mcp-new") return <McpWizard {...props} />;
  const Step = editSteps[props.entry.step] ?? McpServerOverview;
  return <Step {...props} />;
}
