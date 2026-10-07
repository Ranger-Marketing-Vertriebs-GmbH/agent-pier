import React, { useEffect, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectDialogsCopy as copy } from "../../lib/i18n/messages/projects.js";

/**
 * Confirms the merge of an older project entry of this folder into the current
 * project. It lists what moves and warns that SSH access and session permissions
 * move along; nothing merges until the owner confirms.
 */
export default function MergeDuplicateDialog({ project, older, close, merged }) {
  const action = useAsyncAction();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const base = `/memory/projects/${encodeURIComponent(project.memoryId)}/merge`;
  useEffect(() => {
    let alive = true;
    api(`${base}?olderId=${encodeURIComponent(older.id)}`)
      .then((data) => alive && setPreview(data))
      .catch((failure) => alive && setError(failure.message));
    return () => {
      alive = false;
    };
  }, [base, older.id]);
  const moves = preview && [
    copy.mergeEntries(preview.entries),
    copy.mergeCapabilities(preview.capabilities),
    copy.mergeSsh(preview.sshAccess),
    copy.mergeArtifacts(preview.artifacts),
    copy.mergeVerification(preview.verification),
    copy.mergeSessions(preview.sessions),
  ];
  return (
    <Modal
      title={copy.mergeOlder}
      close={close}
      closeDisabled={action.busy}
      className="project-dialog"
    >
      <div className="form-content">
        <p className="field-description">
          {copy.mergeOlderDescription(older.name, formatTimestamp(older.createdAt))}
        </p>
        <h3>{copy.mergeMoves}</h3>
        {moves ? (
          <ul aria-label={copy.mergeMoves}>
            {moves.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          !error && <p role="status">{copy.mergeLoading}</p>
        )}
        <p role="alert">{copy.mergeWarning}</p>
        <ErrorMessage error={action.error || error} />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          disabled={action.busy}
          onClick={close}
        >
          {commonCopy.cancel}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={action.busy || !preview}
          onClick={() =>
            action.run(async () => {
              await api(base, "POST", { olderId: older.id, entries: preview.entries });
              merged();
            })
          }
        >
          {copy.mergeConfirm}
        </button>
      </div>
    </Modal>
  );
}
