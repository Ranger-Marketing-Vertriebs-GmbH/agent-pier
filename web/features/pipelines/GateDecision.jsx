import React, { useState } from "react";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import {
  confirmDescription,
  confirmedActions,
  gateActions,
  requestRunAction,
} from "./run-action-request.js";

export const availableGateActions = (run) =>
  (run.actions || []).filter((action) => gateActions.includes(action));

// The decision the current gate stage waits for: approve, retry with feedback, return
// for repair or override. A failed request keeps the feedback so it can be resent.
export default function GateDecision({ run, node, refresh }) {
  const [feedback, setFeedback] = useState(""),
    [confirm, setConfirm] = useState(null);
  const mutation = useAsyncAction();
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
      <strong id={`run-gate-decision-${node.id}`}>
        {copy.statuses["awaiting-human"]}
      </strong>
      {actions.some((action) => ["feedback", "loop-back"].includes(action)) && (
        <textarea
          aria-label={copy.feedback}
          rows={2}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
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
        <ConfirmAction
          label={copy.actions[confirm]}
          description={confirmDescription(confirm)}
          close={() => setConfirm(null)}
          action={() => execute(confirm)}
        />
      )}
    </section>
  );
}
