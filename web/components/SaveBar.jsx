import React from "react";
import { commonCopy } from "../lib/i18n/messages/common.js";

// One bar per tab or subpage: visible while it has unsaved changes or reports the
// last save's error, conflict or partial result. `saveDisabled` keeps the primary
// disabled while the form is not savable (e.g. a required key re-entry);
// `saveFocusKey` lets an inline confirmation (`useAlertDialogFocus(onCancel,
// returnKey)`) return focus to the primary, also in WebKit where a clicked button
// never had focus.
export default function SaveBar({
  draft,
  onSave,
  onOverwrite,
  saveLabel,
  cancelLabel,
  note,
  saveDisabled = false,
  saveFocusKey,
}) {
  const { outcome } = draft;
  if (!draft.dirty && !draft.saving && !outcome) return null;
  const conflict = outcome?.status === "conflict" || draft.conflicts.length > 0;
  const message = [
    outcome?.partial?.length ? commonCopy.partiallySaved(outcome.partial.join(", ")) : "",
    conflict
      ? commonCopy.changedElsewhere
      : outcome?.status === "error"
        ? outcome.error?.message
        : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="save-bar" role="region" aria-label={commonCopy.unsavedChanges}>
      <div className="save-bar-inner">
        {message ? (
          <p className={`save-bar-note ${conflict ? "warning" : "error"}`} role="alert">
            {message}
          </p>
        ) : (
          <p className="save-bar-note">{note}</p>
        )}
        <div className="save-bar-actions">
          {conflict ? (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={draft.saving}
                onClick={draft.reload}
              >
                {commonCopy.reloadLatest}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={draft.saving}
                onClick={onOverwrite}
              >
                {commonCopy.overwrite}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button secondary"
                disabled={draft.saving}
                onClick={draft.reset}
              >
                {cancelLabel ?? commonCopy.cancel}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={draft.saving || !draft.dirty || saveDisabled}
                data-focus-key={saveFocusKey}
                onClick={onSave}
              >
                {draft.saving ? commonCopy.saving : (saveLabel ?? commonCopy.save)}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
