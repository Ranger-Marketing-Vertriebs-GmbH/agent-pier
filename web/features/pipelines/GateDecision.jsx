import React, { useState } from "react";
import useRunAction from "./useRunAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import { runTitle } from "./run-title.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { formatNumber } from "../../lib/i18n/index.js";
import {
  confirmDescription,
  confirmedActions,
  destructiveActions,
  primaryActions,
  gateActions,
  requestRunAction,
} from "./run-action-request.js";
import "./gate-decision.css";

// As the engine's bound (server/features/pipelines/run-budget.js).
const MAX_TOKEN_BUDGET = 1_000_000_000;

export const availableGateActions = (run) =>
  (run.actions || []).filter((action) => gateActions.includes(action));

// The decision the current gate stage waits for: approve, retry with feedback, return
// for repair or override. A failed request keeps the feedback so it can be resent; the
// run detail owns the feedback so browsing other stages keeps the typed text.
export default function GateDecision({ run, node, refresh, feedback: owned, shared }) {
  const local = useState(""),
    [feedback, setFeedback] = owned || local,
    [confirm, setConfirm] = useState(null),
    [budget, setBudget] = useState("");
  const mutation = useRunAction(shared);
  const actions = availableGateActions(run);
  // A run above its token budget continues with a budget above what it reported.
  const used = run.usage?.totalTokens || 0;
  const budgetValid =
    Number.isSafeInteger(Number(budget)) &&
    Number(budget) > used &&
    Number(budget) <= MAX_TOKEN_BUDGET;
  const execute = async (action) => {
    await requestRunAction(run, action, { feedback, tokenBudget: Number(budget) });
    setConfirm(null);
    setFeedback("");
    setBudget("");
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
      {actions.includes("raise-budget") && (
        <>
          <p>
            {copy.budgetGateHelp(formatNumber(used), formatNumber(run.tokenBudget || 0))}
          </p>
          <label>
            {copy.newTokenBudget}
            <input
              type="number"
              min={used + 1}
              max={MAX_TOKEN_BUDGET}
              step={1}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </label>
        </>
      )}
      <div className="pipeline-actions">
        {actions.map((action) => (
          <button
            key={action}
            className={`button ${primaryActions.includes(action) ? "primary" : "secondary"}`}
            disabled={
              mutation.busy ||
              (action === "feedback" && !feedback.trim()) ||
              (action === "raise-budget" && !budgetValid)
            }
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
