import React from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { useCrossLink } from "../../app/cross-link.js";
export default function AgentsOff({ navigate }) {
  const copy = assistantCopy.feature;
  const settings = useCrossLink()({ view: "settings", settingsSection: "assistants" });
  return (
    <div className="page">
      <h1>{copy.offTitle}</h1>
      <p>{copy.offDescription}</p>
      <button className="button secondary" onClick={() => navigate(settings)}>
        {copy.openSettings}
      </button>
    </div>
  );
}
