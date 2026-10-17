import { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import "./memory.css";

// Confirms permanently forgetting an entry with all its versions. Migration backups
// are deleted only when the owner ticks their separate box.
export default function MemoryForget({ projectId, entry, close, forgotten }) {
  const [reason, setReason] = useState("");
  const [removeBackups, setRemoveBackups] = useState(false);
  const action = useAsyncAction();
  const dismiss = () => {
    if (!action.lock.current) close();
  };
  return (
    <Modal title={copy.forgetTitle} close={dismiss} closeDisabled={action.busy}>
      <form
        className="memory-editor memory-forget"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            await api(
              `/memory/projects/${encodeURIComponent(projectId)}/entries/${encodeURIComponent(entry.id)}`,
              "DELETE",
              { expectedRevision: entry.revision, reason, removeBackups },
            );
            forgotten();
            close();
          });
        }}
      >
        <strong className="memory-forget-title">{entry.title}</strong>
        <p>{copy.forgetWarning}</p>
        <p className="memory-note">{copy.forgetLimit}</p>
        <p className="memory-forget-archives">{copy.forgetArchives}</p>
        <label>
          {copy.forgetReason}
          <input
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={action.busy}
          />
        </label>
        <label className="memory-forget-check">
          <input
            type="checkbox"
            checked={removeBackups}
            onChange={(event) => setRemoveBackups(event.target.checked)}
            disabled={action.busy}
          />
          {copy.forgetRemoveBackups}
        </label>
        <ErrorMessage error={action.error} />
        <div className="memory-actions">
          <button
            type="button"
            className="button secondary"
            onClick={dismiss}
            disabled={action.busy}
          >
            {commonCopy.cancel}
          </button>
          <button className="button danger" disabled={action.busy}>
            {action.busy ? commonCopy.pending : copy.forgetAction}
          </button>
        </div>
      </form>
    </Modal>
  );
}
