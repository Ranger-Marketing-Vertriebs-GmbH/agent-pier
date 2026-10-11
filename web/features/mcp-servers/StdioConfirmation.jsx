import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";

/** Warns that stdio servers run with the owner's rights; the owner confirms or backs out. */
export default function StdioConfirmation({
  binding = false,
  busy,
  onConfirm,
  onCancel,
}) {
  return (
    <div
      className="mcp-confirmation"
      role="alertdialog"
      aria-label={binding ? copy.stdioBindingTitle : copy.stdioWarningTitle}
    >
      <strong>{binding ? copy.stdioBindingTitle : copy.stdioWarningTitle}</strong>
      <p>{binding ? copy.stdioBindingWarning : copy.stdioWarning}</p>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {binding ? copy.stdioBindingConfirm : copy.stdioConfirm}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}
