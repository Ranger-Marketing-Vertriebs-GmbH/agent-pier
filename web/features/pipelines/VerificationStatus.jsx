import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
export function isVerifying(run, node) {
  return run.status === "running" && node?.id === run.currentNodeId && !!run.verifyJob;
}
export default function VerificationStatus({ run, node }) {
  if (!isVerifying(run, node)) return null;
  return (
    <section className="pipeline-verification-status" aria-label={copy.verification}>
      <strong role="status">{copy.verificationRunning}</strong>
      <p>{copy.verificationRunningHelp}</p>
      {run.verifyJob.startedAt && (
        <p>{copy.verificationStarted(formatTimestamp(run.verifyJob.startedAt))}</p>
      )}
      {node.verifyPlan?.length > 0 && (
        <details>
          <summary>{copy.verificationPlan(node.verifyPlan.length)}</summary>
          <ul>
            {node.verifyPlan.map((step, index) => (
              <li key={index}>{step.name || copy.verificationStep(index + 1)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
