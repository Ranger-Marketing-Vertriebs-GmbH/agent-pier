import React from "react";
import StatusChip from "../../components/StatusChip.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { serverText } from "../../lib/server-messages.js";
import "./owner-question.css";

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
      <OwnerQuestion verdict={verdict} />
    </div>
  );
}

// What a stage that asks the owner wants to know, and the files to look at.
export function OwnerQuestion({ verdict }) {
  if (!verdict?.question && !verdict?.files?.length) return null;
  return (
    <div className="pipeline-owner-question">
      {verdict.question && (
        <p>
          <strong>{copy.ownerQuestion}:</strong> {verdict.question}
        </p>
      )}
      {verdict.files?.length > 0 && (
        <>
          <strong>{copy.ownerFiles}</strong>
          <ul>
            {verdict.files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Findings with a severity tag, the title, the file when reported and the detail.
// `answer(finding)` adds a line under each finding, e.g. a repair turn's answer.
export function Findings({ findings, answer }) {
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
            {finding.criterion && <small>{copy.criterionRef(finding.criterion)}</small>}
            {answer?.(finding) && (
              <small className="run-finding-answer">{answer(finding)}</small>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// A stage's report on the spec's acceptance criteria: met or not, with its evidence.
export function CriteriaResults({ criteria }) {
  if (!criteria?.length) return null;
  return (
    <ul className="run-findings">
      {criteria.map((entry) => (
        <li key={entry.criterion}>
          <span className="run-severity">{entry.criterion}</span>
          <span className="run-finding-text">
            <StatusChip tone={entry.status === "met" ? "ok" : "error"}>
              {copy.criterionStatuses[entry.status] || copy.unknown}
            </StatusChip>
            <small>{entry.evidence}</small>
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
      {verdict.ignoredAnswers?.length > 0 && (
        <p>{copy.ignoredAnswers(verdict.ignoredAnswers.join(", "))}</p>
      )}
      <CriteriaResults criteria={verdict.criteria} />
      {verdict.ignoredCriteria?.length > 0 && (
        <p>{copy.ignoredCriteria(verdict.ignoredCriteria.join(", "))}</p>
      )}
    </>
  );
}
