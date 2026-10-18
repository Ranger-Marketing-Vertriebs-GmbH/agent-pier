import React, { useState } from "react";
import useRunAction from "./useRunAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { runTitle } from "./run-title.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import {
  confirmDescription,
  confirmedActions,
  destructiveActions,
  gateActions,
  requestRunAction,
} from "./run-action-request.js";
import "./gate-decision.css";

export const availableGateActions = (run) =>
  (run.actions || []).filter((action) => gateActions.includes(action));

// The decision the current gate stage waits for: approve, retry with feedback, return
// for repair or override. A failed request keeps the feedback so it can be resent; the
// run detail owns the feedback so browsing other stages keeps the typed text.
export default function GateDecision({ run, node, refresh, feedback: owned, shared }) {
  const local = useState(""),
    [feedback, setFeedback] = owned || local,
    [confirm, setConfirm] = useState(null);
  const mutation = useRunAction(shared);
  const actions = availableGateActions(run);
  const execute = async (action) => {
    await requestRunAction(run, action, { feedback });
    setConfirm(null);
    setFeedback("");
    refresh();
  };
  if (!actions.length) return null;
  return (
    <section
      className="run-gate-decision"
      aria-labelledby={`run-gate-decision-${node.id}`}
    >
      <h4 id={`run-gate-decision-${node.id}`}>{copy.statuses["awaiting-human"]}</h4>
      {actions.some((action) => ["feedback", "loop-back"].includes(action)) && (
        <label>
          {copy.feedback}
          <textarea
            aria-label={copy.feedback}
            rows={2}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      )}
      <div className="pipeline-actions">
        {actions.map((action) => (
          <button
            key={action}
            className={`button ${action === "accept" ? "primary" : "secondary"}`}
            disabled={mutation.busy || (action === "feedback" && !feedback.trim())}
            onClick={() =>
              confirmedActions.includes(action)
                ? setConfirm(action)
                : mutation.run(() => execute(action))
            }
          >
            {copy.actions[action]}
          </button>
        ))}
      </div>
      <ErrorMessage error={mutation.error} />
      {confirm && (
        <ConfirmDialog
          destructive={destructiveActions.includes(confirm)}
          title={copy.confirmTitles[confirm](runTitle(run))}
          body={confirmDescription(confirm, run)}
          confirmLabel={copy.confirmLabels[confirm]}
          onCancel={() => setConfirm(null)}
          onConfirm={() => execute(confirm)}
        />
      )}
    </section>
  );
}
