import React, { useEffect, useRef } from "react";
import Sheet from "../../../components/Sheet.jsx";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantShellCopy as shell } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpServerCopy as mcp } from "../../../lib/i18n/messages/mcp-servers.js";

function texts({ kind, data }) {
  if (kind === "fullShell")
    return [shell.fullTitle, [shell.fullBody], shell.confirmFull, shell.cancel];
  if (kind === "shell")
    return [shell.confirmTitle, [shell.warning], shell.confirm, shell.cancel];
  if (kind === "stdio")
    return [
      mcp.stdioBindingTitle,
      [mcp.stdioBindingWarning],
      mcp.stdioBindingConfirm,
      mcp.cancel,
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

/** A save-chain confirmation (shell, full shell, stdio, restart) as a sheet. */
export default function ConfirmationSheet({ confirmation, onShellCancel }) {
  const cancelButton = useRef(null);
  // Enter must not confirm a risky change: Cancel takes the focus that showModal()
  // gave the first button (the sheet's effect runs before this one).
  useEffect(() => {
    if (confirmation) cancelButton.current?.focus();
  }, [confirmation]);
  if (!confirmation) return null;
  const [title, body, confirm, cancelLabel] = texts(confirmation);
  const cancel = () => {
    confirmation.cancel();
    if (confirmation.kind === "shell" || confirmation.kind === "fullShell")
      onShellCancel?.();
  };
  return (
    <Sheet open title={title} onCancel={cancel} className="agent-confirmation-sheet">
      <div className="sheet-body">
        {body.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </div>
      <div className="sheet-actions">
        <button type="button" className="button primary" onClick={confirmation.confirm}>
          {confirm}
        </button>
        <button
          type="button"
          className="button secondary"
          ref={cancelButton}
          onClick={cancel}
        >
          {cancelLabel}
        </button>
      </div>
    </Sheet>
  );
}
