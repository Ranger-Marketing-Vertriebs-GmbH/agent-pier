import React from "react";
import UnsavedChangesSheet from "../../components/UnsavedChangesSheet.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";

// An unsaved document asks with the shared UnsavedChangesSheet, one tab at a time.
export default function FileNavigationGuardDialog({ guard }) {
  const open = Boolean(guard.decision && guard.tab);
  return (
    <UnsavedChangesSheet
      open={open}
      body={open ? copy.guardDescription(guard.tab.path) : ""}
      saveLabel={commonCopy.saveAndContinue}
      busy={open && guard.decision.saving}
      saveDisabled={open && guard.tab.pending}
      onSave={guard.save}
      onDiscard={guard.discard}
      onCancel={guard.cancel}
    >
      {open && guard.tab.error && (
        <p className="sheet-body" role="alert">
          {guard.tab.error.message} {guard.tab.error.code}
        </p>
      )}
    </UnsavedChangesSheet>
  );
}
