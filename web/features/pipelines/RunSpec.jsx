import React, { useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { stageName } from "./run-stages.js";
import "./run-spec.css";

// One numbered item of the spec: its id as a tag, the text and an optional line below.
function SpecItem({ id, text, note, chip }) {
  return (
    <li>
      <span className="run-spec-id">{id}</span>
      <span className="run-spec-text">
        <span className="run-spec-title">{text}</span>
        {chip}
        {note && <small>{note}</small>}
      </span>
    </li>
  );
}

// The run's contract at the top of the run view: who wrote it, whether it is frozen,
// its acceptance criteria and assumptions, the full text and, at a gate, the owner's
// replacement.
export default function RunSpec({ run, refresh }) {
  const [pane, setPane] = useState(null);
  const spec = run.spec;
  if (!spec) return null;
  const node = run.nodes?.find((item) => item.id === spec.nodeId);
  const author =
    spec.source === "owner"
      ? copy.specReplaced(formatTimestamp(spec.at))
      : copy.specWrittenBy(node ? stageName(node) : spec.nodeId);
  const changes = Array.isArray(spec.changes) ? spec.changes : [];
  const criteria = Array.isArray(spec.criteria) ? spec.criteria : [];
  const assumptions = Array.isArray(spec.assumptions) ? spec.assumptions : [];
  const replace = (run.actions || []).includes("replace-spec");
  const submit = async (data) => {
    await api(`/pipeline-runs/${encodeURIComponent(run.id)}/gate`, "POST", {
      action: "replace-spec",
      spec: data.get("spec"),
    });
    setPane(null);
    refresh();
  };
  return (
    <section className="run-spec" aria-labelledby="run-spec-title">
      <h4 id="run-spec-title">{copy.spec}</h4>
      <p className="run-spec-meta">
        <StatusChip tone={spec.frozen ? "ok" : "waiting"} pill>
          {spec.frozen ? copy.specFrozen : copy.specDraft}
        </StatusChip>
        <span>{author}</span>
        <code>{spec.path}</code>
      </p>
      {changes.length > 0 && (
        <p role="note">
          <StatusChip tone="waiting" pill>
            {copy.specChanged(
              changes.length,
              formatTimestamp(changes.at(-1).at),
              changes.at(-1).restored !== false,
            )}
          </StatusChip>
        </p>
      )}
      <span className="run-spec-label">{`${copy.specCriteria} · ${criteria.length}`}</span>
      <ol className="run-spec-items">
        {criteria.map((criterion) => (
          <SpecItem
            key={criterion.id}
            id={criterion.id}
            text={criterion.text}
            note={criterion.verify && copy.specVerify(criterion.verify)}
          />
        ))}
      </ol>
      {assumptions.length > 0 && (
        <details className="run-spec-assumptions">
          <summary>
            {copy.specAssumptions(
              assumptions.length,
              assumptions.filter((a) => a.productDecision).length,
            )}
          </summary>
          <ul className="run-spec-items">
            {assumptions.map((assumption) => (
              <SpecItem
                key={assumption.id}
                id={assumption.id}
                text={assumption.text}
                chip={
                  assumption.productDecision && (
                    <StatusChip tone="waiting">{copy.productDecision}</StatusChip>
                  )
                }
              />
            ))}
          </ul>
        </details>
      )}
      <div className="run-spec-actions">
        <button className="button secondary compact" onClick={() => setPane("view")}>
          {copy.showSpec}
        </button>
        {replace && (
          <button className="button secondary compact" onClick={() => setPane("edit")}>
            {copy.replaceSpec}
          </button>
        )}
      </div>
      {pane === "view" && (
        <Modal title={copy.spec} wide close={() => setPane(null)}>
          <div className="run-spec-dialog">
            <pre className="run-spec-source">{spec.text}</pre>
          </div>
        </Modal>
      )}
      {pane === "edit" && (
        <Modal title={copy.replaceSpec} wide close={() => setPane(null)}>
          <div className="run-spec-dialog">
            <AsyncForm
              submit={submit}
              button={copy.replaceSpecSave}
              close={() => setPane(null)}
            >
              <p>{copy.replaceSpecHelp}</p>
              <label>
                {copy.spec}
                <textarea name="spec" rows={18} defaultValue={spec.text} required />
              </label>
            </AsyncForm>
          </div>
        </Modal>
      )}
    </section>
  );
}
