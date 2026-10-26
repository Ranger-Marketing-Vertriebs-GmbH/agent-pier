import React from "react";
import Icon from "../../../components/Icon.jsx";
import SettingsShell from "../../../components/SettingsShell.jsx";
import useMobileLayout from "../../../lib/useMobileLayout.js";
import { agentWizardCopy as copy } from "../../../lib/i18n/messages/agent-wizard.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { settingsHubCopy } from "../../../lib/i18n/messages/settings.js";
import { wizardSteps } from "./wizard-draft.js";
import "../hub/hub.css";
import "./wizard.css";

/**
 * The wizard's frame (handoff 5.3): a left rail with the six steps on desktop, a
 * progress bar and one step per screen on phones, the step's content, the
 * prerequisites beside it and the bar with Zurück, Überspringen and Weiter.
 */
export default function WizardFrame({
  step,
  reached,
  onStep,
  onBack,
  aside,
  bar,
  children,
}) {
  const phone = useMobileLayout();
  const index = wizardSteps.indexOf(step);
  return (
    <SettingsShell
      className="settings-page-shell agents-hub agent-wizard"
      title={assistantCopy.create}
      subtitle={`${copy.stepOf(index + 1, wizardSteps.length)} · ${copy.draftKept}`}
      leading="back"
      leadingLabel={settingsHubCopy.backTo(assistantCopy.title)}
      onLeading={onBack}
      bar={bar}
    >
      {phone && (
        <progress
          className="agents-hub-progress"
          aria-label={copy.progress}
          max={wizardSteps.length}
          value={index + 1}
        />
      )}
      <div className="agent-wizard-layout">
        {!phone && (
          <nav className="agent-wizard-rail" aria-label={copy.stepsLabel}>
            <ol>
              {wizardSteps.map((id, n) => (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={id === step ? "step" : undefined}
                    disabled={n > reached}
                    onClick={() => onStep(id)}
                  >
                    <span className="agent-wizard-mark" aria-hidden="true">
                      {n < index ? <Icon name="check" size={13} /> : n + 1}
                    </span>
                    <span className="agent-wizard-step-text">
                      <span>{copy.steps[id].label}</span>
                      <small>{copy.steps[id].hint}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <section className="agent-wizard-step" aria-labelledby="agent-wizard-step-title">
          <h2 id="agent-wizard-step-title" tabIndex={-1}>
            {copy.steps[step].label}
          </h2>
          {children}
        </section>
        {!phone && aside && <aside className="agent-wizard-aside">{aside}</aside>}
      </div>
    </SettingsShell>
  );
}
