import React, { useCallback, useState } from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import Modal from "../../components/Modal.jsx";
import { formatBytes } from "../../lib/format-bytes.js";
import { formatTimestamp, locale } from "../../lib/i18n/index.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { assistantDreamingCopy as dreamingCopy } from "../../lib/i18n/messages/assistant-dreaming.js";
import useMemoryNotes from "../assistants/settings/useMemoryNotes.js";
import { userApi } from "./user-api.js";

const shortName = (name) => name.replace(/^memory\//, "");
// The Dream Diary is written by dreaming only: named, read and never deleted here.
const label = (file) => (file.diary ? dreamingCopy.diary : shortName(file.name));

/**
 * Her agent's notes under memory/: each opens to read. From Personalize on she deletes
 * notes of her own agent; a shared agent's memory is everyone's, so the owner manages it.
 */
export default function UserMemoryPage({ agent }) {
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [removing, setRemoving] = useState(null);
  const [reading, setReading] = useState(null);
  const open = async (file) => {
    setReading({ title: label(file), content: null });
    try {
      const note = await userApi.readMemory(agent.id, file.name);
      setReading({
        title: label(file),
        content: note.content ?? "",
        cut: note.truncated
          ? dreamingCopy.diaryTruncated(formatBytes(note.size, locale))
          : "",
      });
    } catch (e) {
      setReading(null);
      setError(e.message);
    }
  };
  const fetchNotes = useCallback(
    (offset) => userApi.memory(agent.id, offset),
    [agent.id],
  );
  const listing = useMemoryNotes(fetchNotes, reload);
  const files = listing.notes;
  const deletable = !agent.shared && ["personalize", "extended"].includes(agent.level);
  return (
    <>
      <ErrorMessage error={error || listing.error} />
      {agent.shared && <p className="user-app-hint">{copy.memoryShared}</p>}
      {files === null ? (
        <p role="status">{copy.loading}</p>
      ) : files.length ? (
        <ListCard label={copy.memory}>
          {files.map((file) => (
            <ListRow
              key={file.name}
              label={label(file)}
              sub={
                file.diary
                  ? `${dreamingCopy.diaryHint} ${formatTimestamp(file.modifiedAt)}`
                  : formatTimestamp(file.modifiedAt)
              }
              onClick={() => open(file)}
              onDelete={deletable && !file.diary ? () => setRemoving(file) : undefined}
              deleteLabel={copy.deleteNote(shortName(file.name))}
            />
          ))}
        </ListCard>
      ) : (
        <p className="user-app-hint">{copy.noNotes}</p>
      )}
      {listing.nextCount > 0 && (
        <button
          type="button"
          className="button secondary compact"
          disabled={listing.loading}
          onClick={listing.loadMore}
        >
          {dreamingCopy.moreNotes(listing.nextCount)}
        </button>
      )}
      {reading && (
        <Modal title={reading.title} close={() => setReading(null)} wide>
          {reading.content === null ? (
            <p role="status">{copy.loading}</p>
          ) : (
            <>
              {reading.cut && <p className="user-app-hint">{reading.cut}</p>}
              <pre className="user-memory-note">{reading.content}</pre>
            </>
          )}
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={copy.deleteNoteTitle(shortName(removing.name))}
          body={copy.deleteNoteBody}
          confirmLabel={copy.deleteNoteConfirm}
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await userApi.removeMemory(agent.id, removing.name);
            setRemoving(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
