import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import RunEvidence from "./RunEvidence.jsx";
export function Verdict({ verdict }) {
  if (!verdict) return null;
  return (
    <div>
      <strong>
        {copy.verdict}: {verdict.result === "pass" ? copy.pass : copy.fail}
      </strong>
      <p>{verdict.summary}</p>
      {verdict.findings?.length > 0 && (
        <ul>
          {verdict.findings.map((finding, index) => (
            <li key={index}>
              <strong>
                {finding.severity} · {finding.title || finding.message}
              </strong>
              {finding.detail && <p>{finding.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export default function RunTimeline({ run, navigate }) {
  return (
    <>
      <h2>{copy.stages}</h2>
      <ol className="pipeline-timeline">
        {run.nodes.map((node) => (
          <li key={node.id}>
            <article
              className={`pipeline-card ${node.id === run.currentNodeId ? "pipeline-gate" : ""}`}
            >
              <h3>{node.profileSnapshot?.name || node.kind || node.id}</h3>
              <p className="pipeline-run-status">
                {copy.nodeStatuses[node.status] || node.status}
                {node.loop && ` · ${node.loop.iteration} / ${node.loop.maxIterations}`}
              </p>
              {node.failReason && <p>{node.failReason}</p>}
              {node.failDetail && <p>{node.failDetail}</p>}
              <Verdict verdict={node.verdict} />
              {node.verifyResult?.status === "not-configured" && <p>{copy.noSteps}</p>}
              {node.gateDecision && (
                <small>
                  {copy.gateDecisions[node.gateDecision] || node.gateDecision}
                </small>
              )}
              {node.sessionId && (
                <div className="pipeline-actions">
                  {["chat", "terminal"].map((mode) => (
                    <a
                      key={mode}
                      href={`/sessions/${encodeURIComponent(node.sessionId)}/${mode}`}
                      onClick={(event) => {
                        if (
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        navigate({
                          view: "workspace",
                          sessionId: node.sessionId,
                          mode: mode === "chat" ? "reader" : "terminal",
                        });
                      }}
                    >
                      {mode === "chat" ? copy.openChat : copy.openTerminal}
                    </a>
                  ))}
                </div>
              )}
              {node.startedAt && (
                <small>
                  {formatTimestamp(node.startedAt)}
                  {node.finishedAt && ` — ${formatTimestamp(node.finishedAt)}`}
                </small>
              )}
              {node.profileSnapshot && (
                <details>
                  <summary>{copy.savedConfiguration}</summary>
                  <p>
                    {node.profileSnapshot.config?.cliTool} ·{" "}
                    {node.profileSnapshot.config?.models?.default || copy.account} ·{" "}
                    {node.profileSnapshot.config?.permissions?.mode}
                  </p>
                </details>
              )}
              {(node.startedAt || node.verdict) && (
                <RunEvidence runId={run.id} node={node} />
              )}
            </article>
          </li>
        ))}
      </ol>
      {run.executionLog?.length > 0 && (
        <details>
          <summary>
            {copy.attempts} ({run.executionLog.length})
          </summary>
          {run.executionLog.map((entry, index) => (
            <article className="pipeline-card" key={entry.id || index}>
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
      )}
    </>
  );
}
