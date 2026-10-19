import React from "react";
import useAsyncAction from "../../lib/useAsyncAction.js";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { formatTimestamp } from "../../lib/i18n/index.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { stageName } from "./run-stages.js";

const nameOf = (run, id) => {
  const node = run.nodes?.find((item) => item.id === id);
  return node ? stageName(node) : id;
};

// Where a change to the frozen spec came from: a stage's turn, a verification run or
// an edit between them.
const changeSource = (run, change) =>
  change.source === "verification"
    ? copy.specChangeSources.verification
    : change.nodeId
      ? nameOf(run, change.nodeId)
      : copy.specChangeSources.manual;

// Changes to the frozen spec, oldest first, each with its source and whether the
// recorded text could be put back.
export function SpecChanges({ run, changes }) {
  if (!changes.length) return null;
  const last = changes.at(-1);
  return (
    <details className="run-spec-history" role="note">
      <summary>
        {copy.specChanged(
          changes.length,
          formatTimestamp(last.at),
          last.restored !== false,
        )}
      </summary>
      <ol className="run-spec-items">
        {changes.map((change, index) => (
          <li key={`${change.at}-${index}`}>
            <span className="run-spec-text">
              <span className="run-spec-title">{changeSource(run, change)}</span>
              <small>
                {formatTimestamp(change.at)} ·{" "}
                {change.restored === false ? copy.specNotRestored : copy.specRestored}
              </small>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

// Every recorded revision of the spec, each readable with the text it had.
export function SpecRevisions({ run, revisions, open }) {
  const action = useAsyncAction();
  if (revisions.length < 2) return null;
  const show = (revision) =>
    action.run(async () => {
      const result = await api(
        `/pipeline-runs/${encodeURIComponent(run.id)}/spec/revisions/${revision.n}`,
      );
      open({
        title: copy.specRevision(revision.n),
        text: result.content || "",
        changed: result.changed === true,
      });
    });
  return (
    <details className="run-spec-history">
      <summary>{copy.specRevisions(revisions.length)}</summary>
      <ol className="run-spec-items">
        {revisions.map((revision) => (
          <li key={revision.n}>
            <span className="run-spec-id">{revision.n}</span>
            <span className="run-spec-text">
              <span className="run-spec-title">
                {revision.source === "owner"
                  ? copy.specRevisionByOwner
                  : nameOf(run, revision.nodeId)}
              </span>
              <small>{formatTimestamp(revision.at)}</small>
              {revision.path && <code>{revision.path}</code>}
            </span>
            {revision.path && (
              <button
                className="button secondary compact"
                aria-label={copy.showSpecRevision(revision.n)}
                disabled={action.busy}
                onClick={() => show(revision)}
              >
                {copy.showSpecRevisionShort}
              </button>
            )}
          </li>
        ))}
      </ol>
      <ErrorMessage error={action.error} />
    </details>
  );
}
