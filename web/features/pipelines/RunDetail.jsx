import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import { locale } from "../../lib/i18n/index.js";
import useResource from "../../lib/useResource.js";
import RunTimeline from "./RunTimeline.jsx";
import RunActions from "./RunActions.jsx";
const format = new Intl.NumberFormat(locale);
export default function RunDetail({ id, navigate }) {
  const resource = useResource(`/pipeline-runs/${encodeURIComponent(id)}`, {
    poll: 5000,
  });
  const run = resource.data?.run;
  return (
    <section>
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
          <h2>{run.task}</h2>
          <p>
            {run.pipelineName} · {run.cwd}
          </p>
          <p className="pipeline-run-status">{copy.statuses[run.status] || run.status}</p>
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
                    {label}: {format.format(run.usage[key])}{" "}
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
          <RunActions
            run={run}
            refresh={resource.refresh}
            removed={() => navigate({ pipelineItem: "" })}
          />
          <RunTimeline run={run} navigate={navigate} />
        </>
      )}
    </section>
  );
}
