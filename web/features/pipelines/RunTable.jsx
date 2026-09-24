import React from "react";
import StatusChip from "../../components/StatusChip.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { isVerifying } from "./VerificationStatus.jsx";
import { runTitle } from "./run-title.js";
import {
  runProgress,
  runProject,
  runStatusTone,
  runUpdatedAt,
} from "./run-presentation.js";
import "./run-table.css";

function RunRow({ run, onOpen, showProject }) {
  const title = runTitle(run);
  const project = runProject(run);
  const progress = runProgress(run);
  const stage = progress.current?.profileSnapshot?.name || progress.current?.id || "";
  const updated = runUpdatedAt(run);
  const verifying = isVerifying(run, progress.current);
  const summary = [
    progress.current ? `${copy.currentStage}: ${stage}` : "",
    progress.total ? copy.runStageProgress(progress.done, progress.total) : "",
  ].filter(Boolean);
  return (
    // Cells with tooltips sit above the row-wide button overlay; their clicks are
    // forwarded here so the whole row still opens the run. The row adds no tab stop:
    // the title button stays the single keyboard control.
    <div
      role="row"
      className={`run-table-row run-table-status-${run.status}`}
      onClick={(event) => {
        if (event.target.closest(".run-table-open")) return;
        if (window.getSelection()?.toString()) return;
        onOpen(run);
      }}
    >
      <div role="cell" className="run-table-task">
        <button
          type="button"
          className="run-table-open"
          aria-label={`${copy.openRun}: ${title}`}
          onClick={() => onOpen(run)}
        >
          <strong className="run-table-title">{title}</strong>
        </button>
        <span className="run-table-pipeline">
          {run.pipelineName}
          {run.createdAt && (
            <>
              {" · "}
              <time dateTime={run.createdAt}>
                {copy.runStarted(formatTimestamp(run.createdAt))}
              </time>
            </>
          )}
        </span>
      </div>
      {showProject && (
        <div role="cell" className="run-table-project">
          {project && <span title={run.cwd}>{project}</span>}
        </div>
      )}
      <div role="cell" className="run-table-progress" title={summary.join(" · ")}>
        <span aria-hidden="true">
          {progress.total
            ? copy.runProgressShort(progress.done, progress.total, stage)
            : ""}
        </span>
        <span className="run-table-bar" aria-hidden="true">
          <span style={{ width: `${progress.percent}%` }} />
        </span>
        {summary.map((text) => (
          <span key={text} className="run-table-sr">
            {text}
          </span>
        ))}
      </div>
      <div role="cell" className="run-table-status">
        <StatusChip tone={verifying ? "running" : runStatusTone(run.status)}>
          {verifying ? copy.verificationRunning : copy.statuses[run.status] || run.status}
        </StatusChip>
      </div>
      <div role="cell" className="run-table-updated">
        {updated && <time dateTime={updated}>{formatTimestamp(updated)}</time>}
      </div>
    </div>
  );
}

export default function RunTable({ runs, onOpen, showProject = true }) {
  return (
    <div
      role="table"
      aria-label={copy.runs}
      className={`run-table${showProject ? "" : " run-table-no-project"}`}
    >
      <div role="row" className="run-table-head">
        <span role="columnheader">{copy.task}</span>
        {showProject && <span role="columnheader">{copy.project}</span>}
        <span role="columnheader">{copy.progress}</span>
        <span role="columnheader">{copy.status}</span>
        <span role="columnheader">{copy.updated}</span>
      </div>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} onOpen={onOpen} showProject={showProject} />
      ))}
    </div>
  );
}
