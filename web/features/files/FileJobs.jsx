import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { filesCopy as copy, fileErrorMessage } from "../../lib/i18n/messages/files.js";
import FileConflictDialog from "./FileConflictDialog.jsx";
import FileJobCard from "./FileJobCard.jsx";
import FileArchiveOmissions from "./FileArchiveOmissions.jsx";
import FileJobRetry from "./FileJobRetry.jsx";
import "./file-jobs.css";
import { uploadOwnedJob } from "./file-job-ownership.js";

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

export default function FileJobs({
  state,
  scopeId,
  scope,
  client,
  searchId,
  onResult,
  collapsed = false,
}) {
  const [retry, setRetry] = useState(null),
    [historyPending, setHistoryPending] = useState(false);
  const [previous, setPrevious] = useState([]);
  const search = state.jobs.find((job) => job.id === searchId);
  const page = state.entries[searchId];
  const selectedChildren = Object.values(
    state.children?.[state.uploadGroupId] || {},
  ).filter(Boolean);
  const currentHistory = state.history?.jobs || state.jobs;
  const displayed = new Set(currentHistory.map((job) => job.id));
  const listed = [
    ...new Map(
      [
        ...currentHistory,
        ...state.jobs.filter(
          (job) =>
            displayed.has(job.id) ||
            isFileJobActive(job) ||
            state.trackedIds.includes(job.id),
        ),
      ].map((job) => [job.id, job]),
    ).values(),
  ];
  // Upload selections have their own bounded view and recovery controls above.
  const visibleJobs = listed.filter((job) => !uploadOwnedJob(job));
  const waiting = [...selectedChildren, ...visibleJobs].find(
    (job) => job.status === "waiting_for_conflict" && job.conflict,
  );
  const history = async (next) => {
    if (historyPending) return;
    setHistoryPending(true);
    try {
      await state.historyPage(
        scopeId,
        next ? state.history.nextCursor : previous.at(-1) || null,
      );
      setPrevious((values) =>
        next ? [...values, state.history?.cursor || null] : values.slice(0, -1),
      );
    } catch {
      /* The shared queue exposes the current-scope error. */
    } finally {
      setHistoryPending(false);
    }
  };
  return (
    <section
      className="file-jobs"
      aria-label={copy.jobs}
      data-collapsed={collapsed || undefined}
    >
      <div hidden={collapsed}>
        <ErrorMessage error={state.error?.message} />
        {state.uncertain
          .filter((item) => item.scopeId === scopeId)
          .map((item) => (
            <div key={item.body.requestId} className="file-job-card">
              <p>
                {copy.jobKinds[item.body.kind]} · {copy.transfers.unknownRequest}
              </p>
              <p>{copy.transfers.sameAttempt}</p>
              <button
                className="button secondary compact"
                onClick={() => state.start(scopeId, item.body).catch(() => {})}
              >
                {copy.transfers.checkRequest}
              </button>
            </div>
          ))}
        <div className="file-action-buttons" aria-label={copy.transfers.history}>
          <button
            className="button secondary compact"
            disabled={historyPending || !state.history?.cursor}
            onClick={() => history(false)}
          >
            {copy.transfers.previousJobs}
          </button>
          <button
            className="button secondary compact"
            disabled={historyPending || !state.history?.nextCursor}
            onClick={() => history(true)}
          >
            {copy.transfers.nextJobs}
          </button>
        </div>
        {visibleJobs.length > 0 && (
          <>
            <h2>{copy.jobs}</h2>
            <ul
              className="file-job-list"
              tabIndex={0}
              aria-label={copy.transfers.history}
            >
              {[...visibleJobs].reverse().map((job) => (
                <FileJobCard
                  key={job.id}
                  job={job}
                  state={state}
                  scopeId={scopeId}
                  client={client}
                  onRetry={setRetry}
                />
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
      </div>
      {waiting?.kind === "archive" && waiting.conflict.type === "archive_links" ? (
        <FileArchiveOmissions
          key={`${waiting.id}:${waiting.conflict.id}:${waiting.conflict.manifestVersion}`}
          job={waiting}
          scopeId={scopeId}
          jobs={state}
          maxEntries={scope.limits.jobEntries}
        />
      ) : (
        waiting && (
          <FileConflictDialog
            key={waiting.conflict.id}
            job={waiting}
            scopeId={scopeId}
            jobs={state}
          />
        )
      )}
      {retry && (
        <FileJobRetry
          key={retry.id}
          job={retry}
          jobs={state}
          scope={scope}
          onClose={() => setRetry(null)}
        />
      )}
    </section>
  );
}
