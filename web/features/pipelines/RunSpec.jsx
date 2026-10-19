import React, { useState } from "react";
import api from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { stageName } from "./run-stages.js";
import { SpecChanges, SpecRevisions } from "./RunSpecHistory.jsx";
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

// Replacing the spec at a gate: the owner's text becomes a new revision.
function ReplaceSpec({ run, text, refresh, close }) {
  const submit = async (data) => {
    await api(`/pipeline-runs/${encodeURIComponent(run.id)}/gate`, "POST", {
      action: "replace-spec",
      spec: data.get("spec"),
    });
    close();
    refresh();
  };
  return (
    <Modal title={copy.replaceSpec} wide close={close}>
      <div className="run-spec-dialog">
        <AsyncForm submit={submit} button={copy.replaceSpecSave} close={close}>
          <p>{copy.replaceSpecHelp}</p>
          <label>
            {copy.spec}
            <textarea name="spec" rows={18} defaultValue={text} required />
          </label>
        </AsyncForm>
      </div>
    </Modal>
  );
}

// The run's contract at the top of the run view: who wrote it, whether it is frozen,
// its acceptance criteria and assumptions, its revisions and changes, the full text
// and, at a gate, the owner's replacement. A stage whose spec was rejected leaves only
// the replacement.
export default function RunSpec({ run, refresh }) {
  const [pane, setPane] = useState(null);
  const spec = run.spec;
  const replace = (run.actions || []).includes("replace-spec");
  if (!spec && !replace) return null;
  if (!spec)
    return (
      <section className="run-spec" aria-labelledby="run-spec-title">
        <h4 id="run-spec-title">{copy.spec}</h4>
        <p>{copy.specRejected}</p>
        <div className="run-spec-actions">
          <button className="button secondary compact" onClick={() => setPane("edit")}>
            {copy.replaceSpec}
          </button>
        </div>
        {pane === "edit" && (
          <ReplaceSpec run={run} text="" refresh={refresh} close={() => setPane(null)} />
        )}
      </section>
    );
  const node = run.nodes?.find((item) => item.id === spec.nodeId);
  const author =
    spec.source === "owner"
      ? copy.specReplaced(formatTimestamp(spec.at))
      : copy.specWrittenBy(node ? stageName(node) : spec.nodeId);
  const changes = Array.isArray(spec.changes) ? spec.changes : [];
  const criteria = Array.isArray(spec.criteria) ? spec.criteria : [];
  const assumptions = Array.isArray(spec.assumptions) ? spec.assumptions : [];
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
      <SpecChanges run={run} changes={changes} />
      <span className="run-spec-label">{`${copy.specCriteria} · ${criteria.length}`}</span>
      <ol className="run-spec-items run-spec-criteria">
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
      <SpecRevisions
        run={run}
        revisions={Array.isArray(spec.revisions) ? spec.revisions : []}
        open={setPane}
      />
      <div className="run-spec-actions">
        <button
          className="button secondary compact"
          onClick={() => setPane({ title: copy.spec, text: spec.text })}
        >
          {copy.showSpec}
        </button>
        {replace && (
          <button className="button secondary compact" onClick={() => setPane("edit")}>
            {copy.replaceSpec}
          </button>
        )}
      </div>
      {pane?.title && (
        <Modal title={pane.title} wide close={() => setPane(null)}>
          <div className="run-spec-dialog">
            {pane.changed && (
              <p>
                <StatusChip tone="waiting" pill>
                  {copy.reportChanged}
                </StatusChip>
              </p>
            )}
            <pre className="run-spec-source">{pane.text}</pre>
          </div>
        </Modal>
      )}
      {pane === "edit" && (
        <ReplaceSpec
          run={run}
          text={spec.text}
          refresh={refresh}
          close={() => setPane(null)}
        />
      )}
    </section>
  );
}
