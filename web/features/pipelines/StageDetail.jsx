import React from "react";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { serverText } from "../../lib/server-messages.js";
import VerificationStatus, { isVerifying } from "./VerificationStatus.jsx";
import EvidenceTiles, {
  VerificationSteps,
  useEvidence,
  verificationSteps,
} from "./RunEvidence.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GateDecision from "./GateDecision.jsx";
import RunUsage from "./RunUsage.jsx";
import { Findings, VerdictSummary } from "./Verdict.jsx";
import { stageName, stageStatus, stageTone } from "./run-stages.js";

function Block({ title, children }) {
  return (
    <section className="run-stage-block">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function SessionLinks({ sessionId, navigate }) {
  return (
    <div className="run-stage-links">
      {["chat", "terminal"].map((mode) => (
        <a
          key={mode}
          href={`/sessions/${encodeURIComponent(sessionId)}/${mode}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate({
              view: "workspace",
              sessionId,
              mode: mode === "chat" ? "reader" : "terminal",
            });
          }}
        >
          {mode === "chat" ? copy.openChat : copy.openTerminal}
        </a>
      ))}
    </div>
  );
}

function StageAttempts({ run, node }) {
  const entries = (run.executionLog || []).filter((entry) => entry.nodeId === node.id);
  if (!entries.length) return null;
  return (
    <Block title={copy.attempts}>
      <ol className="run-stage-history">
        {entries.map((entry, index) => {
          const tone = entry.verdict
            ? entry.verdict.result === "pass"
              ? "ok"
              : "error"
            : entry.failReason
              ? "error"
              : "pending";
          return (
            <li key={entry.id || index}>
              <span className={`run-dot tone-${tone}`} aria-hidden="true" />
              <strong>{copy.attemptNumber(index + 1)}</strong>
              <span>
                {entry.verdict
                  ? `${copy.verdict}: ${entry.verdict.result === "pass" ? copy.pass : copy.fail}`
                  : entry.failReason || ""}
              </span>
              <small>
                {formatTimestamp(entry.startedAt)}
                {entry.finishedAt && ` — ${formatTimestamp(entry.finishedAt)}`}
              </small>
            </li>
          );
        })}
      </ol>
    </Block>
  );
}

// The selected stage: decision, summary, findings, verification, attempts, evidence and
// the whole run's reported usage, in this order.
// `gate` carries the decision's shared feedback and action runner when this stage is the
// current gate stage.
export default function StageDetail({ run, node, index, navigate, refresh, gate }) {
  const evidence = useEvidence(run.id, node);
  const verifying = isVerifying(run, node);
  const steps = verificationSteps(node);
  const notConfigured = node.verifyResult?.status === "not-configured";
  const config = node.profileSnapshot?.config;
  return (
    <article className="run-stage-detail" aria-labelledby={`run-stage-${node.id}`}>
      <header className="run-stage-detail-header">
        <div>
          <span className="run-caps">{copy.stageNumber(index + 1)}</span>
          <div className="run-stage-title">
            <h3 id={`run-stage-${node.id}`}>{stageName(node)}</h3>
            <span className="run-stage-state">
              <span
                className={`run-dot tone-${stageTone(run, node)}`}
                aria-hidden="true"
              />
              <span className="pipeline-run-status">{stageStatus(run, node)}</span>
            </span>
          </div>
        </div>
        {node.sessionId && (
          <SessionLinks sessionId={node.sessionId} navigate={navigate} />
        )}
      </header>
      {gate ? (
        <GateDecision
          run={run}
          node={node}
          refresh={refresh}
          feedback={gate.feedback}
          shared={gate.shared}
        />
      ) : (
        node.gateDecision && (
          <p className="run-gate-confirmation">
            <span className="run-dot tone-ok" aria-hidden="true" />
            {copy.gateDecisions[node.gateDecision] || node.gateDecision}
          </p>
        )
      )}
      {(node.verdict || node.failReason) && (
        <div className="run-stage-summary">
          <VerdictSummary verdict={node.verdict} />
          {node.failReason && <p>{node.failReason}</p>}
          {node.failReason && node.failDetail && <p>{serverText(node.failDetail)}</p>}
        </div>
      )}
      {node.verdict?.findings?.length > 0 && (
        <Block title={`${copy.findings} · ${node.verdict.findings.length}`}>
          <Findings findings={node.verdict.findings} />
        </Block>
      )}
      {(verifying || steps.length > 0 || notConfigured) && (
        <Block title={copy.verification}>
          <VerificationStatus run={run} node={node} />
          {notConfigured && <p>{copy.noSteps}</p>}
          <VerificationSteps evidence={evidence} node={node} />
        </Block>
      )}
      <StageAttempts run={run} node={node} />
      {(node.startedAt || node.verdict) && (
        <Block title={copy.evidence}>
          <EvidenceTiles key={node.id} evidence={evidence} node={node} />
        </Block>
      )}
      <ErrorMessage error={evidence.error} />
      {evidence.viewer}
      <RunUsage usage={run.usage} />
      {(node.startedAt || node.profileSnapshot) && (
        <footer className="run-stage-footer">
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
                {config?.cliTool} · {config?.models?.default || copy.account} ·{" "}
                {config?.permissions?.mode}
              </p>
            </details>
          )}
        </footer>
      )}
    </article>
  );
}
