import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Icon from "../../../components/Icon.jsx";
import LearnMore from "../../../components/LearnMore.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { routePath } from "../../../app/routes.js";
import { agentsHubCopy as copy } from "../../../lib/i18n/messages/agents-hub.js";
import { settingsPageCopy } from "../../../lib/i18n/messages/settings.js";
import { agentsHubRoute } from "../hub-routes.js";

// The steps of switching agents on (RZustaende "Aktivierung läuft"), from the feature
// request and the runtime's availability afterwards.
const activationSteps = ["switchOn", "install", "start"];
const stepIndex = { switching: 0, installing: 1, starting: 2 };

export function ActivationProgress({ phase }) {
  const current = stepIndex[phase] ?? 0;
  return (
    <section className="agents-hub-state" aria-live="polite">
      <h2>{copy.activating.title}</h2>
      <progress
        className="agents-hub-progress"
        aria-label={copy.activating.progress}
        max={activationSteps.length}
        value={current + 0.5}
      />
      <ListCard label={copy.activating.progress}>
        {activationSteps.map((step, index) => (
          <ListRow
            key={step}
            icon={
              index < current ? (
                <Icon name="check" size={14} />
              ) : (
                <StatusDot
                  tone={index === current ? "working" : "idle"}
                  pulse={index === current}
                />
              )
            }
            label={copy.activating[step]}
            className={index === current ? "is-current" : ""}
          />
        ))}
      </ListCard>
      <p className="field-description">{copy.activating.note}</p>
    </section>
  );
}

/**
 * Agents switched off (handoff 5.10): what agents are, "Agenten aktivieren" right here
 * and the progress while they come up. The tabs other than Runtime show this too.
 */
export function AgentsOffState({ feature }) {
  const [error, setError] = useState("");
  const enable = async () => {
    setError("");
    try {
      const next = await feature.setEnabled(true);
      if (next && !next.enabled) setError(settingsPageCopy.agentsNotApplied);
    } catch (e) {
      setError(e.message);
    }
  };
  if (feature.saving) return <ActivationProgress phase="switching" />;
  return (
    <section className="agents-hub-state centered">
      <h2>{copy.off.title}</h2>
      <p>{copy.off.body}</p>
      <div className="agents-hub-state-actions">
        <button
          type="button"
          className="button primary"
          disabled={feature.loading}
          onClick={enable}
        >
          {copy.off.enable}
        </button>
      </div>
      <LearnMore label={copy.off.whatChanges}>
        <p>{copy.off.whatChangesBody}</p>
      </LearnMore>
      <ErrorMessage error={error} />
      <p className="field-description">{copy.off.note}</p>
    </section>
  );
}

/**
 * The agent service stopped while agents are on: a banner with "Dienst starten" and
 * the way to the Runtime tab's diagnostic.
 */
export function ServiceStopped({ onStart, busy, error, navigate }) {
  const runtime = agentsHubRoute("runtime");
  return (
    <div className="agents-hub-banner" role="status">
      <StatusDot tone="error" />
      <p>{copy.stopped.title}</p>
      <div className="agents-hub-state-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onStart}
        >
          {copy.stopped.start}
        </button>
        <a
          className="button secondary"
          href={routePath(runtime)}
          onClick={(event) => {
            event.preventDefault();
            navigate(runtime);
          }}
        >
          {copy.stopped.diagnose}
        </a>
      </div>
      <ErrorMessage error={error} />
    </div>
  );
}
