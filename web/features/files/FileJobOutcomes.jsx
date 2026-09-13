import React, { useState } from "react";
import { filesCopy as copy, fileErrorMessage } from "../../lib/i18n/messages/files.js";

export default function FileJobOutcomes({ job, rows }) {
  const [limit, setLimit] = useState(200);
  const completed = (row) =>
    row.status === "completed" && (job.kind !== "move" || row.sourceRemoved === true);
  const finished = rows.filter(completed),
    unfinished = rows.filter((row) => !completed(row));
  return (
    <details className="file-job-outcomes" open>
      <summary>{copy.actions.results}</summary>
      {[
        [copy.actions.completedResults, finished],
        [copy.actions.unfinishedResults, unfinished],
      ].map(
        ([title, entries]) =>
          entries.length > 0 && (
            <section key={title} aria-label={title}>
              <h4>
                {title} ({entries.length})
              </h4>
              <ul>
                {entries.slice(0, limit).map((entry) => (
                  <li key={entry.id}>
                    <span>
                      {entry.source || entry.path} → {entry.path}
                    </span>
                    {" · "}
                    <span
                      role={
                        job.kind === "restore" && completed(entry) ? "status" : undefined
                      }
                    >
                      {entry.sourceRemovalPending === true
                        ? copy.actions.outcomes.unproven
                        : job.kind === "move" &&
                            entry.outputPublished &&
                            !entry.sourceRemoved
                          ? copy.actions.outcomes.published
                          : job.kind === "restore" && completed(entry)
                            ? copy.actions.restored
                            : copy.actions.outcomes[entry.status] ||
                              copy.actions.outcomes.uncertain}
                    </span>
                    {entry.issue && <p>{fileErrorMessage(entry.issue.code, 500)}</p>}
                  </li>
                ))}
              </ul>
              {entries.length > limit && (
                <button
                  className="button secondary compact"
                  onClick={() => setLimit((value) => value + 200)}
                >
                  {copy.actions.moreResults}
                </button>
              )}
            </section>
          ),
      )}
    </details>
  );
}
