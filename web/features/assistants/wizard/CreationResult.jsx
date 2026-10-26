import React from "react";
import Icon from "../../../components/Icon.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";

const copy = () => agentWizardCopy.result;
const label = (step, d) =>
  step === "routine" ? copy().steps.routine(d.routine?.name || "") : copy().steps[step];

/**
 * "Anlegen nur teilweise geklappt" (handoff 5.3, RZustaende): every step with ✓ or ✕,
 * "Erneut" for a failed one (sent only on that click), "Chat öffnen" and the way to
 * the agent's settings. Shown while the creation runs, too.
 */
export default function CreationResult({
  plan,
  results,
  d,
  busy,
  onRetry,
  onOpenChat,
  onSettings,
}) {
  const failed = plan.filter((step) => results[step]?.status === "failed");
  const created = results.create?.status === "done";
  const running = plan.some((step) => results[step]?.status === "running");
  return (
    <section className="agent-wizard-result" aria-live="polite">
      {running && <p role="status">{copy().creating}</p>}
      {!running && created && failed.length > 0 && (
        <div className="agents-hub-banner" role="alert">
          <StatusDot tone="warning" />
          <p>{copy().partial(d.name.trim(), failed.length, plan.length)}</p>
        </div>
      )}
      <ListCard label={agentWizardCopy.steps.review.label}>
        {plan.map((step) => {
          const result = results[step] || {};
          return (
            <ListRow
              key={step}
              icon={
                result.status === "done" ? (
                  <Icon name="check" size={14} />
                ) : result.status === "failed" ? (
                  <Icon name="close" size={14} />
                ) : (
                  <StatusDot tone={result.status === "running" ? "working" : "idle"} />
                )
              }
              label={label(step, d)}
              sub={
                result.status === "failed"
                  ? result.error || copy().notConfirmed
                  : undefined
              }
              className={`agent-wizard-step-${result.status || "pending"}`}
            >
              {result.status === "failed" && (created || step === "create") && (
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={busy}
                  onClick={() => onRetry(step)}
                >
                  {copy().retry}
                </button>
              )}
            </ListRow>
          );
        })}
      </ListCard>
      {created && !running && (
        <div className="agents-hub-state-actions">
          <button type="button" className="button primary" onClick={onOpenChat}>
            {copy().openChat}
          </button>
          <button type="button" className="button secondary" onClick={onSettings}>
            {copy().later}
          </button>
        </div>
      )}
    </section>
  );
}
