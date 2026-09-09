import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { formatNumber } from "../../lib/i18n/index.js";
import useResource from "../../lib/useResource.js";
import ReactMarkdown from "react-markdown";
import { isVerifying } from "./VerificationStatus.jsx";
import RunTimeline from "./RunTimeline.jsx";
import RunActions from "./RunActions.jsx";
export default function RunDetail({ id, navigate }) {
  const resource = useResource(`/pipeline-runs/${encodeURIComponent(id)}`, {
    poll: 5000,
  });
  const run = resource.data?.run;
  const node = run?.nodes.find((item) => item.id === run.currentNodeId);
  return (
    <section className="pipeline-run-detail">
      <div className="pipeline-toolbar">
        <button
          className="button secondary"
          onClick={() => navigate({ pipelineItem: "" })}
        >
          {commonCopy.back}
        </button>
        <button className="button secondary" onClick={resource.refresh}>
          {commonCopy.refresh}
        </button>
      </div>
      <ErrorMessage error={resource.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {run && (
        <>
          <header className="pipeline-run-heading">
            <h2>{run.pipelineName}</h2>
            <p className="pipeline-status-badge" role="status">
              {isVerifying(run, node)
                ? copy.verificationRunning
                : copy.statuses[run.status] || run.status}
            </p>
          </header>
          <div className="pipeline-run-layout">
            <aside className="pipeline-run-sidebar" aria-label={copy.runOverview}>
              <section className="pipeline-card pipeline-run-meta">
                <h3>{copy.runOverview}</h3>
                <p>{run.cwd}</p>
                {run.branch && <p>{run.branch}</p>}
                {run.usage && (
                  <div role="group" aria-label={copy.usage}>
                    {[
                      ["inputTokens", copy.input],
                      ["outputTokens", copy.output],
                      ["totalTokens", copy.total],
                    ].map(([key, label]) =>
                      Number.isFinite(run.usage[key]) ? (
                        <span key={key}>
                          {label}: {formatNumber(run.usage[key])}{" "}
                        </span>
                      ) : null,
                    )}
                    {Number.isFinite(run.usage.costUsd) && (
                      <span>
                        {copy.cost}: {run.usage.costUsd} USD
                      </span>
                    )}
                  </div>
                )}
                {run.pullRequestUrl && (
                  <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">
                    {run.pullRequestUrl}
                  </a>
                )}
              </section>
              <RunActions
                run={run}
                refresh={resource.refresh}
                removed={() => navigate({ pipelineItem: "" })}
              />
            </aside>
            <div className="pipeline-run-content">
              <details className="pipeline-card pipeline-task">
                <summary>{copy.task}</summary>
                <div className="pipeline-prose">
                  <ReactMarkdown>{run.task}</ReactMarkdown>
                </div>
              </details>
              <RunTimeline run={run} navigate={navigate} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
