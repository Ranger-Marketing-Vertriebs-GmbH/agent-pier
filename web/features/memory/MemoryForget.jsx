import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";
import "./memory.css";

// Confirms permanently forgetting an entry with all its versions. Migration backups
// are deleted only when the owner ticks their separate box, shown only when some
// exist. Only the explicit button forgets: Enter in the reason field does not.
export default function MemoryForget({ projectId, entry, close, forgotten }) {
  const [reason, setReason] = useState("");
  const [removeBackups, setRemoveBackups] = useState(false);
  const [backups, setBackups] = useState(0);
  const [incomplete, setIncomplete] = useState(null);
  const action = useAsyncAction();
  useEffect(() => {
    const controller = new AbortController();
    api("/memory/migration-backups", "GET", undefined, controller.signal)
      .then((result) => setBackups(result.count))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const dismiss = () => {
    if (!action.lock.current) close();
  };
  const forget = () =>
    action.run(async () => {
      const result = await api(
        `/memory/projects/${encodeURIComponent(projectId)}/entries/${encodeURIComponent(entry.id)}`,
        "DELETE",
        {
          expectedRevision: entry.revision,
          reason,
          removeBackups: backups > 0 && removeBackups,
        },
      );
      forgotten();
      if (result.purged === false || result.redacted === false)
        setIncomplete({
          files: result.purged === false,
          records: result.redacted === false,
        });
      else close();
    });
  if (incomplete)
    return (
      <Modal title={copy.forgetTitle} close={close}>
        <div className="memory-editor memory-forget">
          <div role="status" className="memory-forget-archives">
            {incomplete.files && <p>{copy.forgetIncomplete}</p>}
            {incomplete.records && <p>{copy.forgetRecordsIncomplete}</p>}
          </div>
          <div className="memory-actions">
            <button type="button" className="button primary" onClick={close}>
              {commonCopy.close}
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal title={copy.forgetTitle} close={dismiss} closeDisabled={action.busy}>
      <form
        className="memory-editor memory-forget"
        onSubmit={(event) => event.preventDefault()}
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
        {backups > 0 && (
          <label className="memory-forget-check">
            <input
              type="checkbox"
              checked={removeBackups}
              onChange={(event) => setRemoveBackups(event.target.checked)}
              disabled={action.busy}
            />
            {copy.forgetRemoveBackups(backups)}
          </label>
        )}
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
          <button
            type="button"
            className="button danger"
            disabled={action.busy}
            onClick={forget}
          >
            {action.busy ? commonCopy.pending : copy.forgetAction}
          </button>
        </div>
      </form>
    </Modal>
  );
}
