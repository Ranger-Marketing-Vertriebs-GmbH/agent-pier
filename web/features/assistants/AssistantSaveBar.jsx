import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
// Phone-only save controls for the agent profile form. They submit the form by id, so
// the bar can sit at the end of the settings page while the form stays where it is. A
// failed save is repeated here because the form's own error is off screen.
export default function AssistantSaveBar({ form, busy, creating, error, onCancel }) {
  return (
    <div className="assistant-save-bar">
      {error ? (
        <ErrorMessage error={error} as="p" className="error assistant-save-error" />
      ) : (
        !creating && <p>{copy.pendingConfigShort}</p>
      )}
      <button className="button secondary" type="button" onClick={onCancel}>
        {copy.cancel}
      </button>
      <button className="button primary" type="submit" form={form} disabled={busy}>
        {busy ? copy.loading : copy.save}
      </button>
    </div>
  );
}
