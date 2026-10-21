import React from "react";
import "./agent-run-state.css";
import StatusDot from "../../components/StatusDot.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { agentRunStepsCopy as copy } from "../../lib/i18n/messages/agent-run-steps.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { stalledMinutes, useNow } from "./run-steps.js";

const tones = { running: "working", done: "ok", failed: "error" };
const toolName = (step) => copy.tools[step.tool] || copy.tool(step.tool || "?");
const stepName = (step) => (step.kind === "thinking" ? copy.thinking : toolName(step));

// What the turn does now: the running tool with its title, or the phase.
function phaseText(view) {
  if (view.phase === "retrying")
    return copy.retrying(view.retry?.attempt, view.retry?.of);
  if (view.phase === "tool" || view.phase === "approval") {
    const step = view.steps.findLast((s) => s.kind === "tool" && s.state === "running");
    if (step) return step.label ? `${toolName(step)} · ${step.label}` : toolName(step);
    return copy.phase.tool;
  }
  return copy.phase[view.phase] || copy.phase.model;
}

/**
 * The state of a chat's latest turn below its messages, for the owner's and a user's
 * chat: the attempt's status, while it runs its live steps (collapsed, the newest
 * last), a turn that hears nothing from the model with Stop and Try again, a turn
 * of unknown outcome (`explainUncertain` says why; `onRecover` reviews it), why a
 * failed turn ended, and a hint when the chat grew very long. `onStop`, `onRetry` and
 * `onRecover` are null where the chat cannot act.
 */
export default function AgentRunState({
  attempt,
  shownAttempt,
  active,
  uncertain,
  compacting,
  steps,
  longChat,
  busy,
  onStop,
  onRetry,
  awaiting,
  explainUncertain = false,
  onRecover,
}) {
  const running = Boolean(active && !uncertain);
  const view = running && !compacting ? steps : null;
  // Re-renders while it runs; a new frame re-renders at once, so read the clock here.
  useNow(Boolean(view));
  const stalled = stalledMinutes(view, Date.now());
  const failure = !active && attempt?.state === "failed" ? attempt.failure : null;
  return (
    <>
      {attempt && (
        <p
          role="status"
          className={`assistant-note assistant-run-state${running ? " working" : ""}`}
          data-compacting={compacting || undefined}
          data-phase={view?.phase}
        >
          {running && <StatusDot tone="working" pulse className="assistant-run-dot" />}
          {compacting
            ? assistantCopy.compaction.running
            : view
              ? phaseText(view)
              : assistantCopy.status[shownAttempt.state]}
        </p>
      )}
      {view && view.steps.length > 0 && (
        <details className="assistant-run-steps">
          <summary>{copy.stepCount(view.steps.length + view.omitted)}</summary>
          <ol aria-label={copy.steps}>
            {view.omitted > 0 && (
              <li className="assistant-run-step omitted">{copy.earlier(view.omitted)}</li>
            )}
            {view.steps.map((step) => (
              <li key={step.id} className="assistant-run-step" data-state={step.state}>
                <StatusDot tone={tones[step.state]} className="assistant-run-step-dot" />
                <span className="assistant-run-step-name">
                  {stepName(step)}
                  {step.label && (
                    <span className="assistant-run-step-label"> · {step.label}</span>
                  )}
                </span>
                <span className="assistant-run-step-state">{copy.state[step.state]}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {stalled > 0 && (
        <div className="assistant-notice assistant-run-stalled" role="status">
          <p>{copy.stalled(stalled)}</p>
          {onStop && (
            <>
              <p>{copy.stalledHint}</p>
              <div className="assistant-run-actions">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={onStop}
                >
                  {assistantCopy.stopShort}
                </button>
                {onRetry && (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={onRetry}
                  >
                    {commonCopy.retry}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {awaiting && <p className="assistant-notice">{assistantCopy.unconfirmed}</p>}
      {uncertain && explainUncertain && (
        <p className="assistant-notice">
          {attempt.reviewedAt ? assistantCopy.reviewed : assistantCopy.uncertain}
        </p>
      )}
      {uncertain && !attempt.reviewedAt && onRecover && (
        <div className="assistant-notice">
          <p>{assistantCopy.recoverNotice}</p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onRecover}
          >
            {assistantCopy.recover}
          </button>
        </div>
      )}
      {failure && (
        <div className="assistant-notice assistant-run-failure" data-failure={failure}>
          <p>{copy.timedOut}</p>
          {onRetry && (
            <div className="assistant-run-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={onRetry}
              >
                {commonCopy.retry}
              </button>
            </div>
          )}
        </div>
      )}
      {longChat && !active && (
        <p className="assistant-notice assistant-long-chat" role="status">
          {copy.longChat}
        </p>
      )}
    </>
  );
}
