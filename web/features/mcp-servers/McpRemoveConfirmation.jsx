import React, { useId } from "react";
import { useAlertDialogFocus } from "../../components/useAlertDialogFocus.js";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";

/**
 * Asks before a server is removed; focus starts on the safe choice and returns to the
 * Remove button, found by its key: Safari on macOS does not focus it on click.
 */
export default function McpRemoveConfirmation({ server, busy, onConfirm, onCancel }) {
  const focus = useAlertDialogFocus(onCancel, `remove-${server.id}`);
  const textId = useId();
  return (
    <div
      {...focus}
      className="mcp-confirmation"
      role="alertdialog"
      aria-labelledby={textId}
    >
      <p id={textId}>{copy.confirmRemove(server.name)}</p>
      <div className="mcp-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {copy.confirmRemoveAction}
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
