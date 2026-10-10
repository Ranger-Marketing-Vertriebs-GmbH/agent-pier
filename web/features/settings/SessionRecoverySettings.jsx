import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { settingsPageCopy as copy } from "../../lib/i18n/messages/settings.js";

export default function SessionRecoverySettings({ state, refresh, ready }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const enabled = state.autoResumeInterrupted !== false;
  return (
    <section className="settings-form session-recovery">
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          aria-label={copy.autoResumeLabel}
          checked={enabled}
          disabled={busy || !ready}
          onChange={async (event) => {
            setBusy(true);
            setError("");
            try {
              await api("/preferences", "PATCH", {
                autoResumeInterrupted: event.target.checked,
              });
              await refresh();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        />
        {copy.autoResumeLabel}
      </label>
      <p className="field-description">{copy.autoResumeDescription}</p>
      <ErrorMessage error={error} />
    </section>
  );
}
