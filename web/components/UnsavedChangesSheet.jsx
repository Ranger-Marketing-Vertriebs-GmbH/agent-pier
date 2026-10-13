import React from "react";
import Sheet from "./Sheet.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";

export default function UnsavedChangesSheet({
  open,
  tab,
  count,
  busy,
  onSave,
  onDiscard,
  onCancel,
}) {
  return (
    <Sheet
      open={open}
      title={commonCopy.unsavedTitle}
      onCancel={onCancel}
      className="unsaved-changes-sheet"
    >
      <p className="sheet-body">{commonCopy.unsavedBody(tab, count)}</p>
      <div className="sheet-actions">
        <button type="button" className="button primary" disabled={busy} onClick={onSave}>
          {busy ? commonCopy.saving : commonCopy.saveAndSwitch}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onDiscard}
        >
          {commonCopy.discard}
        </button>
        <button type="button" className="button text" disabled={busy} onClick={onCancel}>
          {commonCopy.cancel}
        </button>
      </div>
    </Sheet>
  );
}
