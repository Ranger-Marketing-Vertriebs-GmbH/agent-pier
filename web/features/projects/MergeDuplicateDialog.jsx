import React, { useEffect, useId, useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { projectDialogsCopy as copy } from "../../lib/i18n/messages/projects.js";
import "./project-dialogs.css";

/**
 * Confirms the merge of an older project entry of this folder into the current
 * project. It lists what moves and notes that SSH access and session permissions
 * move along; nothing merges until the owner confirms. The merge is refused when
 * anything changed after this preview.
 */
export default function MergeDuplicateDialog({ project, older, close, merged }) {
  const action = useAsyncAction();
  const movesId = useId();
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
    ...(preview.archivedEntries ? [copy.mergeArchived(preview.archivedEntries)] : []),
    copy.mergeCapabilities(preview.capabilities),
    copy.mergeSsh(preview.sshAccess),
    copy.mergeArtifacts(preview.artifacts),
    copy.mergeVerification(preview.verification),
    preview.sessions === null
      ? copy.mergeSessionsUnknown
      : copy.mergeSessions(preview.sessions),
  ];
  // While the merge runs, neither Esc nor the close button drops its result.
  const dismiss = () => {
    if (!action.lock.current) close();
  };
  return (
    <Modal
      title={copy.mergeOlder}
      close={dismiss}
      closeDisabled={action.busy}
      className="project-dialog"
    >
      <div className="form-content">
        <p className="field-description">
          {copy.mergeOlderDescription(older.name, formatTimestamp(older.createdAt))}
        </p>
        <h3 id={movesId}>{copy.mergeMoves}</h3>
        {moves ? (
          <ul aria-labelledby={movesId}>
            {moves.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          !error && <p role="status">{copy.mergeLoading}</p>
        )}
        <p className="project-merge-warning">{copy.mergeWarning}</p>
        <ErrorMessage error={action.error || error} />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          disabled={action.busy}
          onClick={dismiss}
        >
          {commonCopy.cancel}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={action.busy || !preview}
          onClick={() =>
            action.run(async () => {
              await api(base, "POST", {
                olderId: older.id,
                fingerprint: preview.fingerprint,
              });
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
