import React from "react";
import ReactMarkdown from "react-markdown";
import Icon from "../../components/Icon.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { isVerifying } from "./VerificationStatus.jsx";
import RunActions from "./RunActions.jsx";
import { runTitle } from "./run-title.js";
import { runProject, runStatusTone } from "./run-presentation.js";

// Back link, task title, status, meta line and the run-wide actions; the task text
// stays collapsible below. `decisionCue` leads to the waiting gate stage while another
// stage is shown.
export default function RunHeader({ run, back, refresh, exclude, shared, decisionCue }) {
  const node = run.nodes?.find((item) => item.id === run.currentNodeId);
  const verifying = isVerifying(run, node);
  const project = runProject(run);
  const meta = [
    run.pipelineName,
    project && (
      <span key="project" title={run.cwd}>
        {project}
      </span>
    ),
    run.branch && copy.runBranch(run.branch),
    run.createdAt && copy.runStartedMeta(formatTimestamp(run.createdAt)),
  ].filter(Boolean);
  return (
    <>
      <button type="button" className="run-back" onClick={back}>
        <Icon name="back" size={16} />
        {copy.allRuns}
      </button>
      <header className="run-header">
        <div className="run-header-main">
          <div className="run-header-title">
            <h2>{runTitle(run)}</h2>
            <span className="run-header-status" role="status">
              <StatusChip tone={verifying ? "running" : runStatusTone(run.status)}>
                {verifying
                  ? copy.verificationRunning
                  : copy.statuses[run.status] || run.status}
              </StatusChip>
            </span>
          </div>
          <p className="run-header-meta">
            {meta.map((part, index) => (
              <React.Fragment key={index}>
                {index > 0 && " · "}
                {part}
              </React.Fragment>
            ))}
          </p>
          {run.pullRequestUrl && (
            <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">
              {run.pullRequestUrl}
            </a>
          )}
        </div>
        <div className="run-header-actions">
          {decisionCue && (
            <button
              className="button primary run-decision-cue"
              onClick={decisionCue.select}
            >
              {copy.decisionCue(decisionCue.stage)}
            </button>
          )}
          <button className="button secondary" onClick={refresh}>
            {commonCopy.refresh}
          </button>
          <RunActions
            run={run}
            refresh={refresh}
            removed={back}
            exclude={exclude}
            shared={shared}
          />
        </div>
      </header>
      <details className="pipeline-card pipeline-task">
        <summary>{copy.task}</summary>
        <div className="pipeline-prose">
          <ReactMarkdown>{run.task}</ReactMarkdown>
        </div>
      </details>
    </>
  );
}
