import React, { useCallback, useEffect, useState } from "react";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import { userApi } from "./user-api.js";

/**
 * Her agent's notes under memory/. From Personalize on she deletes notes of her own
 * agent; a shared agent's memory is everyone's, so the owner manages it.
 */
export default function UserMemoryPage({ agent }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(null);
  const load = useCallback(async () => {
    try {
      setFiles((await userApi.memory(agent.id)).files || []);
    } catch (e) {
      setError(e.message);
      setFiles([]);
    }
  }, [agent.id]);
  useEffect(() => {
    load();
  }, [load]);
  const deletable = !agent.shared && ["personalize", "extended"].includes(agent.level);
  return (
    <>
      <ErrorMessage error={error} />
      {agent.shared && <p className="user-app-hint">{copy.memoryShared}</p>}
      {files === null ? (
        <p role="status">{copy.loading}</p>
      ) : files.length ? (
        <ListCard label={copy.memory}>
          {files.map((file) => (
            <ListRow
              key={file.name}
              label={file.name.replace(/^memory\//, "")}
              sub={formatTimestamp(file.modifiedAt)}
              onDelete={deletable ? () => setRemoving(file) : undefined}
              deleteLabel={copy.deleteNote(file.name.replace(/^memory\//, ""))}
            />
          ))}
        </ListCard>
      ) : (
        <p className="user-app-hint">{copy.noNotes}</p>
      )}
      {removing && (
        <ConfirmDialog
          title={copy.deleteNoteTitle(removing.name.replace(/^memory\//, ""))}
          body={copy.deleteNoteBody}
          confirmLabel={copy.deleteNoteConfirm}
          destructive
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await userApi.removeMemory(agent.id, removing.name);
            setRemoving(null);
            await load();
          }}
        />
      )}
    </>
  );
}
