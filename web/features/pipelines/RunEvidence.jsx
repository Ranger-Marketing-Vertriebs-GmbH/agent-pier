import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
export default function RunEvidence({ runId, node }) {
  const [pane, setPane] = useState(null),
    [artifacts, setArtifacts] = useState(null);
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
  const steps =
    node.verifyResult?.steps ||
    node.verifyResult?.repos?.flatMap((repo) => repo.steps) ||
    [];
  return (
    <div>
      <div className="pipeline-actions">
        <button
          className="button secondary compact"
          disabled={action.busy}
          onClick={() => open("/diff", copy.diff, "diff")}
        >
          {copy.diff}
        </button>
        <button
          className="button secondary compact"
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const result = await api(base + "/artifacts");
              setArtifacts(
                (result.artifacts || []).flatMap((item) =>
                  Array.isArray(item.artifacts)
                    ? item.nodeId === node.id
                      ? item.artifacts
                      : []
                    : item,
                ),
              );
            })
          }
        >
          {copy.artifacts}
        </button>
      </div>
      {artifacts && (
        <div className="pipeline-actions">
          {!artifacts.length && <p>{copy.noArtifacts}</p>}
          {artifacts.map((artifact) => (
            <button
              key={artifact.path}
              className="button secondary compact"
              disabled={action.busy || artifact.exists === false}
              onClick={() =>
                open(
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
      {steps.map((step, index) => (
        <div className="pipeline-actions" key={index}>
          <small>
            {step.name} · {step.blocking ? copy.blocking : copy.verification} ·{" "}
            {step.timedOut ? copy.unknown : (step.exitCode ?? copy.unknown)}
          </small>
          <button
            className="button secondary compact"
            disabled={action.busy}
            onClick={() => open("/verify-logs/" + index, copy.logs, "log")}
          >
            {copy.logs}
          </button>
        </div>
      ))}
      <ErrorMessage error={action.error} />
      {pane && (
        <Modal title={pane.title} wide close={() => setPane(null)}>
          <div className="pipeline-form">
            <pre className="pipeline-evidence">{pane.text}</pre>
            {pane.truncated && <p>{copy.truncated}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
