import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import { formatNumber } from "../../lib/i18n/index.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

export const verificationSteps = (node) =>
  node.verifyResult?.steps ||
  node.verifyResult?.repos?.flatMap((repo) => repo.steps) ||
  [];

// One viewer, one busy state and one error area for all evidence of a stage.
export function useEvidence(runId, node) {
  const [pane, setPane] = useState(null);
  const action = useAsyncAction();
  const base = `/pipeline-runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.id)}`;
  const open = (suffix, title, field) =>
    action.run(async () => {
      const result = await api(base + suffix);
      setPane({
        title,
        text: result[field] || (field === "diff" ? copy.emptyDiff : ""),
        truncated: result.truncated,
      });
    });
  // The log tile shows every step's log; several steps are separated by their names.
  const openLogs = (steps) =>
    action.run(async () => {
      const logs = [];
      for (const index of steps.keys())
        logs.push(await api(`${base}/verify-logs/${index}`));
      setPane({
        title: copy.logs,
        text:
          steps.length === 1
            ? logs[0].log || ""
            : logs
                .map((result, index) => `── ${steps[index].name} ──\n${result.log || ""}`)
                .join("\n\n"),
        truncated: logs.some((result) => result.truncated),
      });
    });
  return {
    base,
    busy: action.busy,
    error: action.error,
    run: action.run,
    open,
    openLogs,
    viewer: pane && (
      <Modal title={pane.title} wide close={() => setPane(null)}>
        <div className="pipeline-form">
          <pre className="pipeline-evidence">{pane.text}</pre>
          {pane.truncated && <p>{copy.truncated}</p>}
        </div>
      </Modal>
    ),
  };
}

const stepResult = (step) =>
  step.timedOut
    ? copy.verificationTimedOut
    : step.exitCode === 0
      ? copy.pass
      : Number.isInteger(step.exitCode)
        ? copy.verificationExitCode(step.exitCode)
        : copy.unknown;

const stepTone = (step) =>
  step.exitCode === 0
    ? "ok"
    : step.timedOut || Number.isInteger(step.exitCode)
      ? "error"
      : "pending";

// Verification rows: name, gate role and result, the configured command, the duration
// and the step's own log.
export function VerificationSteps({ evidence, node }) {
  return verificationSteps(node).map((step, index) => (
    <div className="run-verify-step" key={index}>
      <span className={`run-dot tone-${stepTone(step)}`} aria-hidden="true" />
      <small>
        {step.name} · {step.blocking ? copy.blocking : copy.verification} ·{" "}
        {stepResult(step)}
      </small>
      {node.verifyPlan?.[index]?.command && <code>{node.verifyPlan[index].command}</code>}
      {Number.isFinite(step.durationMs) && (
        <span className="run-verify-duration">
          {copy.seconds(
            formatNumber(step.durationMs / 1000, { maximumFractionDigits: 1 }),
          )}
        </span>
      )}
      <button
        className="button secondary compact"
        aria-label={copy.stepLog(step.name)}
        disabled={evidence.busy}
        onClick={() => evidence.open("/verify-logs/" + index, copy.logs, "log")}
      >
        {copy.logs}
      </button>
    </div>
  ));
}

// Evidence tiles: changes, reported files (listed below the tiles) and the verification log.
export default function EvidenceTiles({ evidence, node }) {
  const [artifacts, setArtifacts] = useState(null);
  const steps = verificationSteps(node);
  const loadArtifacts = () =>
    evidence.run(async () => {
      const result = await api(evidence.base + "/artifacts");
      setArtifacts(
        (result.artifacts || []).flatMap((item) =>
          Array.isArray(item.artifacts)
            ? item.nodeId === node.id
              ? item.artifacts
              : []
            : item,
        ),
      );
    });
  return (
    <>
      <div className="run-evidence-tiles">
        <button
          className="run-evidence-tile"
          disabled={evidence.busy}
          onClick={() => evidence.open("/diff", copy.diff, "diff")}
        >
          {copy.diff}
        </button>
        <button
          className="run-evidence-tile"
          disabled={evidence.busy}
          onClick={loadArtifacts}
        >
          {copy.artifacts}
        </button>
        <button
          className="run-evidence-tile"
          disabled={evidence.busy || !steps.length}
          onClick={() => evidence.openLogs(steps)}
        >
          {copy.logs}
        </button>
      </div>
      {artifacts && (
        <div className="pipeline-actions">
          {!artifacts.length && <p>{copy.noArtifacts}</p>}
          {artifacts.map((artifact) => (
            <button
              key={artifact.path}
              className="button secondary compact"
              disabled={evidence.busy || artifact.exists === false}
              onClick={() =>
                evidence.open(
                  "/artifact?path=" + encodeURIComponent(artifact.path),
                  artifact.label || artifact.path,
                  "content",
                )
              }
            >
              {artifact.label || artifact.path}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
