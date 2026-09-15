import React from "react";
import Modal from "../../components/Modal.jsx";
import { fileEditorCopy as copy } from "../../lib/i18n/messages/file-editor.js";

export default function FileNavigationGuardDialog({ guard }) {
  if (!guard.decision || !guard.tab) return null;
  return (
    <Modal
      title={copy.guardTitle}
      close={guard.cancel}
      closeDisabled={guard.decision.saving}
    >
      <p>{copy.guardDescription(guard.tab.path)}</p>
      {guard.tab.error && (
        <p role="alert">
          {guard.tab.error.message} {guard.tab.error.code}
        </p>
      )}
      <div className="dialog-actions">
        <button
          onClick={guard.save}
          disabled={guard.decision.saving || guard.tab.pending}
        >
          {guard.decision.saving || guard.tab.pending ? copy.saving : copy.guardSave}
        </button>
        <button onClick={guard.discard} disabled={guard.decision.saving}>
          {copy.guardDiscard}
        </button>
        <button onClick={guard.cancel} disabled={guard.decision.saving}>
          {copy.guardCancel}
        </button>
      </div>
    </Modal>
  );
}
