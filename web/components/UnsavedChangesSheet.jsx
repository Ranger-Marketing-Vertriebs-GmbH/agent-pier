import React from "react";
import Sheet from "./Sheet.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";

// The only unsaved-changes dialog: save (and continue), discard, or stay. `body`
// replaces the default text that names the tab and the number of changed fields;
// `children` adds details such as a failed save's error.
export default function UnsavedChangesSheet({
  open,
  tab,
  count,
  busy,
  onSave,
  onDiscard,
  onCancel,
  body,
  saveLabel = commonCopy.saveAndSwitch,
  saveDisabled = false,
  children,
}) {
  return (
    <Sheet
      open={open}
      title={commonCopy.unsavedTitle}
      onCancel={onCancel}
      className="unsaved-changes-sheet"
    >
      <p className="sheet-body">{body ?? commonCopy.unsavedBody(tab, count)}</p>
      {children}
      <div className="sheet-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || saveDisabled}
          onClick={onSave}
        >
          {busy ? commonCopy.saving : saveLabel}
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
