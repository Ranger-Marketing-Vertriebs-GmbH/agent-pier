import React, { useState } from "react";
import { filesCopy as copy } from "../../lib/i18n/messages/files.js";
import { isTerminal } from "./file-action-utils.js";
import { FileJobIssue } from "./FileJobs.jsx";
import FileJobOutcomes from "./FileJobOutcomes.jsx";

const amount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? String(value) : copy.transfers.unknown;
export default function FileJobCard({ job, state, scopeId, client, onRetry }) {
  const [expanded, setExpanded] = useState(false);
  const metadata = ["search", "size"].includes(job.kind),
    active = !isTerminal(job);
  const page = state.entries[job.id];
  const show = () => {
    setExpanded(true);
    state.inspectResults(scopeId, job.id).catch(() => {});
  };
  return (
    <li className="file-job-card" data-job-id={job.id}>
      <div className="file-job-heading">
        <span>
          {copy.jobKinds[job.kind] || copy.operation} · {copy.jobStates[job.status]}
        </span>
        <span>
          {metadata
            ? copy.scanned(job.completedEntries)
            : copy.transfers.entries(
                amount(job.completedEntries),
                amount(job.totalEntries),
              )}
        </span>
        {active && (
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
      {!metadata && (
        <p>{copy.transfers.bytes(amount(job.completedBytes), amount(job.totalBytes))}</p>
      )}
      {job.kind === "archive" && active && (
        <p role="status">{copy.transfers.preparing}</p>
      )}
      {["archive", "extract"].includes(job.kind) && (
        <p>{copy.transfers.publicationPolicy}</p>
      )}
      {job.destination && <p>{copy.actions.destination(job.destination)}</p>}
      {job.kind === "extract" &&
        job.status === "completed" &&
        job.completedEntries === 0 && <p>{copy.transfers.noneExtracted}</p>}
      {["partially_completed", "interrupted", "cancelled", "failed"].includes(
        job.status,
      ) && <p>{copy.transfers.retainedResults}</p>}
      <FileJobIssue issue={job.issue} />
      {job.kind === "archive" &&
        job.status === "completed" &&
        job.artifactReady === true && (
          <a
            className="button secondary compact"
            href={client.archiveDownload(job.id)}
            download
          >
            {copy.transfers.downloadArchive}
          </a>
        )}
      {job.kind === "archive" &&
        job.status === "completed" &&
        job.archiveOutput === "download" &&
        job.artifactReady !== true && <p>{copy.transfers.artifactUnavailable}</p>}
      <div className="file-action-buttons">
        {!metadata && (
          <button className="button secondary compact" onClick={show}>
            {copy.transfers.showResults}
          </button>
        )}
        {["partially_completed", "interrupted", "cancelled", "failed"].includes(
          job.status,
        ) && (
          <button className="button secondary compact" onClick={() => onRetry(job)}>
            {copy.transfers.reviewRetry}
          </button>
        )}
      </div>
      {!metadata && page && (expanded || active || state.entries[job.id]?.complete) && (
        <>
          <FileJobOutcomes job={job} rows={page.entries} />
          {page.nextCursor && (
            <button
              className="button secondary compact"
              onClick={() =>
                state.refresh({ jobId: job.id, cursor: page.nextCursor }).catch(() => {})
              }
            >
              {copy.transfers.nextEntries}
            </button>
          )}
        </>
      )}
    </li>
  );
}
