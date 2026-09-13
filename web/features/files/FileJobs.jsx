import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy, fileErrorMessage } from "../../lib/i18n/messages/files.js";

export const isFileJobActive = (job) =>
  job && ["queued", "running", "waiting_for_conflict", "cancelling"].includes(job.status);

export function FileJobIssue({ issue }) {
  if (!issue) return null;
  const reason = copy.incompleteReasons[issue.args?.reason];
  return (
    <p role="status" className="file-job-issue">
      {fileErrorMessage(issue.code, 500)}
      {reason ? ` ${reason}.` : ""}
    </p>
  );
}

export default function FileJobs({ state, scopeId, searchId, onResult }) {
  const search = state.jobs.find((job) => job.id === searchId);
  const page = state.entries[searchId];
  return (
    <section className="file-jobs" aria-label={copy.jobs}>
      <ErrorMessage error={state.error?.message} />
      {state.jobs.length > 0 && (
        <>
          <h2>{copy.jobs}</h2>
          <ul className="file-job-list">
            {[...state.jobs].reverse().map((job) => (
              <li key={job.id}>
                <div className="file-job-heading">
                  <span>
                    {copy.jobKinds[job.kind] || copy.operation} ·{" "}
                    {copy.jobStates[job.status]}
                  </span>
                  <span>{copy.scanned(job.completedEntries)}</span>
                  {isFileJobActive(job) && (
                    <button
                      type="button"
                      className="button secondary compact"
                      disabled={job.status === "cancelling"}
                      onClick={() => state.cancel(scopeId, job.id).catch(() => {})}
                    >
                      {copy.stop}
                    </button>
                  )}
                </div>
                <FileJobIssue issue={job.issue} />
              </li>
            ))}
          </ul>
        </>
      )}
      {search && (
        <section aria-label={copy.searchResults}>
          <h3>{copy.searchResults}</h3>
          {page &&
            page.entries.length === 0 &&
            !isFileJobActive(search) &&
            !search.issue &&
            search.status === "completed" && <p>{copy.noResults}</p>}
          <ul className="file-search-results">
            {(page?.entries || []).map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => onResult(entry)}>
                  {entry.name}
                </button>
                <span>{entry.path}</span>
              </li>
            ))}
          </ul>
          {page?.nextCursor && (
            <button
              type="button"
              className="button secondary compact"
              onClick={() =>
                state
                  .refresh({ jobId: searchId, cursor: page.nextCursor })
                  .catch(() => {})
              }
            >
              {copy.moreResults}
            </button>
          )}
        </section>
      )}
    </section>
  );
}
