import React from "react";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
// Phone-only save controls for the agent profile form. They submit the form by id, so
// the bar can sit at the end of the settings page while the form stays where it is.
export default function AssistantSaveBar({ form, busy, creating, onCancel }) {
  return (
    <div className="assistant-save-bar">
      {!creating && <p>{copy.pendingConfigShort}</p>}
      <button className="button secondary" type="button" onClick={onCancel}>
        {copy.cancel}
      </button>
      <button className="button primary" type="submit" form={form} disabled={busy}>
        {busy ? copy.loading : copy.save}
      </button>
    </div>
  );
}
