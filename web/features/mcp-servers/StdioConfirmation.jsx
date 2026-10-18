import React from "react";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import { mcpCliCopy as cliCopy } from "../../lib/i18n/messages/mcp-cli.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";

/**
 * Warns that stdio servers run with the owner's rights; the owner confirms or backs
 * out. `binding` asks for an agent, `cli` for coding CLIs.
 */
export default function StdioConfirmation({
  binding = false,
  cli = false,
  busy,
  returnKey,
  onConfirm,
  onCancel,
}) {
  const focus = useAlertDialogFocus(onCancel, returnKey);
  const title = cli
    ? cliCopy.stdioCliTitle
    : binding
      ? copy.stdioBindingTitle
      : copy.stdioWarningTitle;
  const warning = cli
    ? cliCopy.stdioCliWarning
    : binding
      ? copy.stdioBindingWarning
      : copy.stdioWarning;
  const confirmLabel = cli
    ? cliCopy.stdioCliConfirm
    : binding
      ? copy.stdioBindingConfirm
      : copy.stdioConfirm;
  return (
    <div {...focus} className="mcp-confirmation" role="alertdialog" aria-label={title}>
      <strong>{title}</strong>
      <p>{warning}</p>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="button secondary"
          data-autofocus
          disabled={busy}
          onClick={onCancel}
        >
          {commonCopy.cancel}
        </button>
      </div>
    </div>
  );
}
