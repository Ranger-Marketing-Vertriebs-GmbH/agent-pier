import React, { useState } from "react";
import useRunAction from "./useRunAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import {
  confirmDescription,
  confirmedActions,
  requestRunAction,
} from "./run-action-request.js";

// Renders the engine-authorized run actions in server order; `exclude` hides actions
// another control (the gate decision block) already offers. An optional `shared` action
// runner lets several action areas of one run disable each other while one is pending.
export default function RunActions({ run, refresh, removed, exclude = [], shared }) {
  const [feedback, setFeedback] = useState(""),
    [resumeAt, setResumeAt] = useState(""),
    [confirm, setConfirm] = useState(null);
  const mutation = useRunAction(shared);
  const actions = (run.actions || []).filter(
    (action) => copy.actions[action] && !exclude.includes(action),
  );
  const execute = async (action) => {
    if (await requestRunAction(run, action, { feedback, resumeAt })) {
      removed();
      return;
    }
    setConfirm(null);
    setFeedback("");
    refresh();
  };
  if (!actions.length) return null;
  return (
    <section className="pipeline-card pipeline-gate">
      {actions.some((action) => ["feedback", "loop-back"].includes(action)) && (
        <label>
          {copy.feedback}
          <textarea
            aria-label={copy.feedback}
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
        </label>
      )}
      {actions.includes("wait-for-reset") && (
        <label>
          {copy.resumeAt}
          <input
            type="datetime-local"
            value={resumeAt}
            onChange={(event) => setResumeAt(event.target.value)}
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
