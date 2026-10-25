import React from "react";
import { systemStatusCopy as copy } from "../../lib/i18n/messages/system-status.js";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { CLEANUP_API, cleanupSize, useCleanup } from "./useCleanup.jsx";
import { statusTime } from "./system-status-format.js";

/** The agents' update backups, each with its update, date and size. */
export default function CleanupSnapshots() {
  const text = copy.cleanup.snapshots;
  const { data, confirm, feedback } = useCleanup("update-backups");
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  return (
    <>
      {feedback}
      {data && data.blocked && <p className="hint">{text.blocked}</p>}
      {data && !snapshots.length && <p className="hint">{text.empty}</p>}
      {snapshots.length > 0 && (
        <ListCard label={text.label}>
          {snapshots.map((snapshot) => {
            const date = statusTime(snapshot.createdAt);
            const size = cleanupSize(snapshot.bytes, snapshot.partial);
            const update =
              snapshot.previousVersion && snapshot.targetVersion
                ? text.versions(snapshot.previousVersion, snapshot.targetVersion)
                : text.unknownVersions;
            return (
              <ListRow
                key={snapshot.id}
                label={date}
                sub={
                  snapshot.reason === "recovery" ? `${update} · ${text.recovery}` : update
                }
                value={size}
                disabled={!!snapshot.reason}
                deleteLabel={text.deleteLabel(date)}
                onDelete={() =>
                  confirm({
                    title: text.confirmTitle(date),
                    body: [
                      text.confirmBody(size),
                      text.confirmWarning(snapshot.previousVersion),
                    ],
                    confirmLabel: text.confirm,
                    path: `${CLEANUP_API}/update-backups/${encodeURIComponent(snapshot.id)}`,
                    method: "DELETE",
                  })
                }
              />
            );
          })}
        </ListCard>
      )}
    </>
  );
}
