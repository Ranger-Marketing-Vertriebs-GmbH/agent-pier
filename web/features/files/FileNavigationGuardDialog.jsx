import React from "react";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";

// An unsaved document asks with the shared UnsavedChangesSheet, one tab at a time.
// While a save runs, Escape and Cancel keep the sheet open.
export default function FileNavigationGuardDialog({ guard }) {
  const open = Boolean(guard.decision && guard.tab);
  const saving = open && guard.decision.saving;
  const pending = open && guard.tab.pending;
  return (
    <UnsavedChangesSheet
      open={open}
      body={open ? copy.guardDescription(guard.tab.path) : ""}
      saveLabel={pending ? commonCopy.saving : commonCopy.saveAndContinue}
      busy={saving}
      saveDisabled={pending}
      onSave={guard.save}
      onDiscard={guard.discard}
      onCancel={() => {
        if (!saving) guard.cancel();
      }}
    >
      {open && guard.tab.error && (
        <p className="sheet-body" role="alert">
          {guard.tab.error.message} {guard.tab.error.code}
        </p>
      )}
    </UnsavedChangesSheet>
  );
}
