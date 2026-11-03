import React, { useEffect, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { formatTimestamp } from "../../../lib/i18n/index.js";
import { memoryReviewCopy as copy } from "../../../lib/i18n/messages/assistant-memory-reviews.js";
import { assistantApi } from "../assistant-api.js";

/**
 * The entries the owner archived from the agent's memory after a model switch, read
 * only. **Restore** acts at once, outside the page's draft: the entry goes back to the
 * end of its file and `onRestored(file)` shows that file again. `locked` (a user's
 * own agent under her opt-in) lists them without Restore.
 */
export default function MemoryArchiveList({ assistantId, locked = false, onRestored }) {
  const [entries, setEntries] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(null),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    assistantApi.memoryArchive(assistantId).then(
      (next) => live && setEntries(next.entries || []),
      (e) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [assistantId, reload]);
  async function restore(entry) {
    setBusy(entry.id);
    setError("");
    try {
      const result = await assistantApi.restoreArchived(assistantId, entry.id);
      setReload((n) => n + 1);
      onRestored?.(result.file);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  if (!entries && !error) return null;
  return (
    <section
      className="memory-archive"
      aria-label={copy.archiveTitle}
      data-memory-archive=""
    >
      <GroupLabel hint={copy.archiveHint} hintLabel={copy.archiveTitle}>
        {copy.archiveTitle}
      </GroupLabel>
      <ErrorMessage error={error} />
      {entries?.length === 0 && <p className="assistant-note">{copy.archiveEmpty}</p>}
      {entries?.length > 0 && (
        <ListCard label={copy.archiveTitle}>
          {entries.map((entry) => (
            <ListRow
              key={entry.id}
              label={entry.text}
              sub={[entry.file, copy.archived(formatTimestamp(entry.archivedAt))]
                .concat(
                  entry.switch ? [copy.switched(entry.switch.from, entry.switch.to)] : [],
                )
                .join(" · ")}
            >
              {!locked && (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy !== null}
                  onClick={() => restore(entry)}
                >
                  {copy.restore}
                </button>
              )}
            </ListRow>
          ))}
        </ListCard>
      )}
    </section>
  );
}
