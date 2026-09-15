import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { fileTransfersCopy as copy } from "../../lib/i18n/messages/file-transfers.js";
import { fileErrorMessage } from "../../lib/i18n/messages/files.js";
import "./file-transfers.css";

const active = (job) =>
  job && ["queued", "running", "waiting_for_conflict", "cancelling"].includes(job.status);
function Inputs({ onFiles, readOnly, reselection = false }) {
  return (
    <div className="file-upload-inputs">
      <label>
        {reselection ? copy.reselect : copy.files}
        <input
          type="file"
          multiple
          disabled={readOnly}
          onChange={(event) => {
            onFiles(event.currentTarget);
            event.currentTarget.value = "";
          }}
        />
      </label>
      <label>
        {reselection ? copy.reselectFolder : copy.folder}
        <input
          type="file"
          webkitdirectory=""
          multiple
          disabled={readOnly}
          onChange={(event) => {
            onFiles(event.currentTarget);
            event.currentTarget.value = "";
          }}
        />
      </label>
    </div>
  );
}
function TransferRows({ group, uploads, jobs, readOnly }) {
  const [page, setPage] = useState(0);
  const rows = group.rows.slice(page * 200, (page + 1) * 200);
  return (
    <>
      <ul className="file-upload-rows">
        {rows.map((row) => {
          const attempt = group.attempts.get(row.id);
          const child = jobs.children?.[group.serverId]?.[row.id];
          const captured = { attempt, childId: child?.id };
          const closed =
            ["completed", "skipped", "published"].includes(row.status) ||
            row.outputPublished;
          let status = closed ? row.status : attempt?.phase || row.status;
          if (status === "completed" && row.status !== "completed") status = "checking";
          const issue =
            attempt?.error ||
            (row.issue ? { message: fileErrorMessage(row.issue.code, 409) } : null);
          const retry =
            !closed &&
            [
              "failed",
              "cancelled",
              "interrupted",
              "blocked",
              "reservation_unknown",
              "checking",
            ].includes(status);
          const canCancel =
            active(child) ||
            (attempt &&
              ["new", "reserving", "waiting", "sending", "checking"].includes(
                attempt.phase,
              )) ||
            (group.autoplay && group.files.has(row.relativePath) && !attempt);
          return (
            <li key={row.id}>
              <strong>{row.relativePath}</strong>
              <span className="file-upload-target">{row.path}</span>
              <span role="status">{copy.states[status] || copy.states.checking}</span>
              {row.type === "file" && (
                <progress
                  aria-label={copy.progress(row.relativePath)}
                  max={row.bytes || 1}
                  value={Math.min(
                    row.bytes || 1,
                    row.status === "completed"
                      ? row.bytes || 1
                      : attempt?.loaded || row.completedBytes || 0,
                  )}
                />
              )}
              <ErrorMessage error={issue?.message} />
              {child === null && (
                <span className="field-description">{copy.unavailable}</span>
              )}
              <div className="file-action-buttons">
                {row.type === "file" && retry && (
                  <button
                    className="button secondary compact"
                    disabled={readOnly || !group.files.has(row.relativePath)}
                    onClick={() => uploads.retry(group, row.id, captured)}
                  >
                    {["checking", "blocked", "reservation_unknown"].includes(status)
                      ? copy.check(row.relativePath)
                      : copy.retry(row.relativePath)}
                  </button>
                )}
                {row.type === "file" && canCancel && !closed && (
                  <button
                    className="button secondary compact"
                    disabled={readOnly || attempt?.cancelRequested}
                    onClick={() => uploads.cancel(group, row.id, captured)}
                  >
                    {copy.cancel(row.relativePath)}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="file-action-buttons">
        {page > 0 && (
          <button className="button secondary compact" onClick={() => setPage(page - 1)}>
            {copy.previous}
          </button>
        )}
        {(page + 1) * 200 < group.rows.length && (
          <button className="button secondary compact" onClick={() => setPage(page + 1)}>
            {copy.next}
          </button>
        )}
      </div>
    </>
  );
}
function UploadHistory({ jobs, scopeId, uploads }) {
  const [previous, setPrevious] = useState([]);
  const page = jobs.history;
  const groups = page?.jobs.filter((job) => job.kind === "upload_group") || [];
  return (
    <details className="file-upload-history">
      <summary>{copy.history}</summary>
      {!groups.length && <p>{copy.historyEmpty}</p>}
      <ul>
        {groups.map((job) => (
          <li key={job.id}>
            <button
              className="button secondary compact"
              onClick={() => uploads.recover(job)}
            >
              {copy.group(job.id.slice(0, 8))} · {copy.states[job.status]}
            </button>
          </li>
        ))}
      </ul>
      <div className="file-action-buttons">
        {previous.length > 0 && (
          <button
            className="button secondary compact"
            onClick={() => {
              jobs
                .uploadHistory(scopeId, previous.at(-1))
                .then(() => setPrevious(previous.slice(0, -1)))
                .catch(() => {});
            }}
          >
            {copy.previousHistory}
          </button>
        )}
        {page?.nextCursor && (
          <button
            className="button secondary compact"
            onClick={() => {
              jobs
                .uploadHistory(scopeId, page.nextCursor)
                .then(() => setPrevious([...previous, page.cursor]))
                .catch(() => {});
            }}
          >
            {copy.nextHistory}
          </button>
        )}
      </div>
    </details>
  );
}
export default function FileUploads({ uploads, jobs, scope }) {
  const group = uploads.selected;
  const external = (event) =>
    !scope.readOnly &&
    event.dataTransfer.types.includes("Files") &&
    !event.dataTransfer.types.includes("application/x-agentpier-files");
  const missing = group?.rows.some(
    (row) =>
      row.type === "file" &&
      !["completed", "skipped"].includes(row.status) &&
      !group.files.has(row.relativePath),
  );
  return (
    <section className="file-uploads" aria-label={copy.title}>
      <h2>{copy.title}</h2>
      <Inputs onFiles={uploads.add} readOnly={scope.readOnly} />
      <p className="field-description">{copy.folderNotice}</p>
      <div
        className="file-upload-drop"
        role="region"
        aria-label={copy.destination}
        onDragOver={(event) => {
          if (external(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          if (external(event)) {
            event.preventDefault();
            event.stopPropagation();
            uploads.add(event.dataTransfer);
          }
        }}
      >
        <span>{copy.drop}</span>
        <strong>{scope.path || "/"}</strong>
      </div>
      <UploadHistory
        key={scope.scopeId}
        jobs={jobs}
        scopeId={scope.scopeId}
        uploads={uploads}
      />
      {uploads.groups.length > 1 && (
        <div className="file-action-buttons">
          {uploads.groups.map((item) => (
            <button
              key={item.id}
              className="button secondary compact"
              aria-pressed={item === group}
              onClick={() => uploads.select(item)}
            >
              {copy.select(item.folder || item.serverId?.slice(0, 8) || "")}
            </button>
          ))}
        </div>
      )}
      {group && (
        <div className="file-upload-group">
          <p>{group.folder}</p>
          <p role="status">
            {group.job?.status === "completed"
              ? copy.completed
              : copy.states[
                  group.phase === "active" && group.job ? group.job.status : group.phase
                ]}
          </p>
          {group.omissions.map((key) => (
            <p role="status" key={key}>
              {copy[key]}
            </p>
          ))}
          {group.phase === "empty" && <p>{copy.empty}</p>}
          <ErrorMessage error={group.error?.message} />
          {missing && (
            <>
              <p role="status">{copy.missing}</p>
              <Inputs
                reselection
                onFiles={(input) => uploads.reselect(input, group)}
                readOnly={scope.readOnly}
              />
            </>
          )}
          <div className="file-action-buttons">
            {group.phase === "metadata_unknown" && (
              <button
                className="button secondary compact"
                disabled={scope.readOnly || group.submitting}
                onClick={() => uploads.retry(group)}
              >
                {copy.checkGroup}
              </button>
            )}
            {(active(group.job) ||
              ["selecting", "planning", "metadata_unknown"].includes(group.phase)) && (
              <button
                className="button secondary compact"
                disabled={scope.readOnly || group.cancelRequested}
                onClick={() => uploads.cancel(group)}
              >
                {copy.cancelGroup}
              </button>
            )}
          </div>
          <TransferRows
            key={group.id}
            group={group}
            uploads={uploads}
            jobs={jobs}
            readOnly={scope.readOnly}
          />
        </div>
      )}
    </section>
  );
}
