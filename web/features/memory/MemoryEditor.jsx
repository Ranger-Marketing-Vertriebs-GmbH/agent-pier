import { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { memoryCopy as copy } from "../../lib/i18n/messages/memory.js";

export default function MemoryEditor({ projectId, entry, close, saved }) {
  const [title, setTitle] = useState(entry?.title || "");
  const [content, setContent] = useState(entry?.content || "");
  const [revision, setRevision] = useState(entry?.revision);
  const action = useAsyncAction();
  const dismiss = () => {
    if (!action.lock.current) close();
  };
  const base = `/memory/projects/${encodeURIComponent(projectId)}/entries`;
  const latest = () =>
    action.run(async () => {
      const current = await api(`${base}/${encodeURIComponent(entry.id)}`);
      setTitle(current.title);
      setContent(current.content);
      setRevision(current.revision);
    });
  return (
    <Modal
      title={entry ? copy.editEntry : copy.newEntry}
      close={dismiss}
      closeDisabled={action.busy}
      wide
    >
      <form
        className="memory-editor"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            await api(
              entry ? `${base}/${encodeURIComponent(entry.id)}` : base,
              entry ? "PATCH" : "POST",
              { title, content, ...(entry ? { expectedRevision: revision } : {}) },
            );
            saved();
            close();
          });
        }}
      >
        <label>
          {copy.entryTitle}
          <input
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={action.busy}
          />
        </label>
        <label>
          {copy.content}
          <textarea
            required
            maxLength={32768}
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            disabled={action.busy}
          />
        </label>
        <p className="memory-note">{copy.reference}</p>
        <ErrorMessage error={action.error} />
        <div className="memory-actions">
          {entry && action.error && (
            <button
              type="button"
              className="button secondary"
              disabled={action.busy}
              onClick={latest}
            >
              {copy.latest}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            onClick={dismiss}
            disabled={action.busy}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy}>
            {action.busy ? commonCopy.pending : commonCopy.save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
