import React from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as shell } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpServerCopy as mcp } from "../../../lib/i18n/messages/mcp-servers.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";

function texts({ kind, data }) {
  if (kind === "fullShell")
    return [shell.fullTitle, [shell.fullBody], shell.confirmFull, commonCopy.cancel];
  if (kind === "shell")
    return [shell.confirmTitle, [shell.warning], shell.confirm, commonCopy.cancel];
  if (kind === "stdio")
    return [
      mcp.stdioBindingTitle,
      [mcp.stdioBindingWarning],
      mcp.stdioBindingConfirm,
      commonCopy.cancel,
    ];
  const copy = assistantCopy.personal;
  const names = (data?.affected?.agents || []).map((agent) => agent.name).join(", ");
  return [
    copy.restartTitle,
    [copy.restartBody, copy.restartAffected(names, data?.affected?.teamMembers)],
    copy.restartConfirm,
    copy.restartCancel,
  ];
}

/**
 * A save-chain confirmation (shell, full shell, stdio, restart). The change is risky
 * but not destructive: a primary button, with Cancel focused so Enter never confirms.
 */
export default function ConfirmationSheet({ confirmation, onShellCancel }) {
  if (!confirmation) return null;
  const [title, body, confirm, cancelLabel] = texts(confirmation);
  const cancel = () => {
    confirmation.cancel();
    if (confirmation.kind === "shell" || confirmation.kind === "fullShell")
      onShellCancel?.();
  };
  return (
    <ConfirmDialog
      key={confirmation.kind}
      title={title}
      body={body}
      confirmLabel={confirm}
      cancelLabel={cancelLabel}
      focusCancel
      onCancel={cancel}
      onConfirm={confirmation.confirm}
    />
  );
}
