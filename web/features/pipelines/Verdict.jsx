import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { serverText } from "../../lib/server-messages.js";

// Result line and summary; long summaries stay collapsed behind a disclosure.
export function VerdictSummary({ verdict }) {
  if (!verdict) return null;
  return (
    <div className="pipeline-verdict">
      <strong>
        {copy.verdict}: {verdict.result === "pass" ? copy.pass : copy.fail}
      </strong>
      {verdict.summary?.length > 600 ? (
        <details className="pipeline-verdict-summary">
          <summary>{copy.resultSummary}</summary>
          <p>{serverText(verdict.summary)}</p>
        </details>
      ) : (
        verdict.summary && <p>{serverText(verdict.summary)}</p>
      )}
    </div>
  );
}

// Findings with a severity tag, the title, the file when reported and the detail.
export function Findings({ findings }) {
  if (!findings?.length) return null;
  return (
    <ul className="run-findings">
      {findings.map((finding, index) => (
        <li key={index}>
          <span className={`run-severity severity-${finding.severity}`}>
            {copy.severities[finding.severity] || finding.severity}
          </span>
          <span className="run-finding-text">
            <span className="run-finding-title">{finding.title || finding.message}</span>
            {finding.file && <code>{finding.file}</code>}
            {finding.detail && <small>{finding.detail}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function Verdict({ verdict }) {
  if (!verdict) return null;
  return (
    <>
      <VerdictSummary verdict={verdict} />
      <Findings findings={verdict.findings} />
    </>
  );
}
