import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { isVerifying } from "./VerificationStatus.jsx";

export default function RunListCard({ run, open }) {
  const headline = (run.task || "")
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ");
  const title = headline.length > 160 ? headline.slice(0, 157).trimEnd() + "…" : headline;
  const nodes = run.nodes || [];
  const current = nodes.find((node) => node.id === run.currentNodeId);
  const project = (run.cwd || "").split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <article className="pipeline-card pipeline-run-card">
      <div className="pipeline-run-card-heading">
        <h3>{title || run.pipelineName}</h3>
        <span className={`pipeline-run-state state-${run.status}`}>
          {isVerifying(run, current)
            ? copy.verificationRunning
            : copy.statuses[run.status] || run.status}
        </span>
      </div>
      <p className="pipeline-run-card-meta">
        <span>{run.pipelineName}</span>
        {project && <span title={run.cwd}>{project}</span>}
        {run.createdAt && (
          <time dateTime={run.createdAt}>{formatTimestamp(run.createdAt)}</time>
        )}
      </p>
      <div className="pipeline-run-card-footer">
        <div className="pipeline-run-stage-summary">
          {current && (
            <span>
              {copy.currentStage}: {current.profileSnapshot?.name || current.id}
            </span>
          )}
          {nodes.length > 0 && (
            <small>
              {copy.runStageProgress(
                nodes.filter((node) => node.status === "passed").length,
                nodes.length,
              )}
            </small>
          )}
        </div>
        <button
          className="button secondary"
          aria-label={`${copy.openRun}: ${title || run.pipelineName}`}
          onClick={open}
        >
          {copy.openRun}
        </button>
      </div>
    </article>
  );
}
