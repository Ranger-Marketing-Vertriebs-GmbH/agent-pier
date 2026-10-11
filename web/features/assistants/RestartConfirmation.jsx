import React from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";

/** The owner confirms a change that restarts the agents' service before it is saved. */
export default function RestartConfirmation({ affected, busy, onConfirm, onCancel }) {
  const copy = assistantCopy.personal;
  const names = (affected?.agents || []).map((agent) => agent.name);
  return (
    <div
      className="assistant-restart-confirmation"
      role="alertdialog"
      aria-label={copy.restartTitle}
    >
      <strong>{copy.restartTitle}</strong>
      <p>{copy.restartBody}</p>
      <p className="assistant-note">
        {copy.restartAffected(names.join(", "), affected?.teamMembers)}
      </p>
      <div className="assistant-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={onConfirm}
        >
          {copy.restartConfirm}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          {copy.restartCancel}
        </button>
      </div>
    </div>
  );
}
