import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import Verdict from "./Verdict.jsx";

// The complete execution log of the run across all stages and attempts.
export default function ExecutionHistory({ run }) {
  if (!run.executionLog?.length) return null;
  return (
    <details className="run-execution-log">
      <summary>
        {copy.attempts} ({run.executionLog.length})
      </summary>
      {run.executionLog.map((entry, index) => (
        <article className="run-execution-entry" key={entry.id || index}>
          <h3>
            {entry.nodeId} · {entry.kind}
          </h3>
          <small>
            {formatTimestamp(entry.startedAt)}
            {entry.finishedAt && ` — ${formatTimestamp(entry.finishedAt)}`}
          </small>
          <Verdict verdict={entry.verdict} />
          {entry.failReason && <p>{entry.failReason}</p>}
          {entry.sessionId && (
            <a href={`/sessions/${encodeURIComponent(entry.sessionId)}/chat`}>
              {copy.openChat}
            </a>
          )}
        </article>
      ))}
    </details>
  );
}
