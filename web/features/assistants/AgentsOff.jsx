import React from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
export default function AgentsOff({ navigate }) {
  const copy = assistantCopy.feature;
  return (
    <div className="page">
      <h1>{copy.offTitle}</h1>
      <p>{copy.offDescription}</p>
      <button
        className="button secondary"
        onClick={() => navigate({ view: "settings", settingsSection: "assistants" })}
      >
        {copy.openSettings}
      </button>
    </div>
  );
}
