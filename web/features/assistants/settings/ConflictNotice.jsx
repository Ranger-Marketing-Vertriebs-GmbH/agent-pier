import React from "react";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";

// Fields edited here and changed on the server: the edit is kept until reloaded.
export default function ConflictNotice({ draft, labels }) {
  if (!draft.conflicts.length) return null;
  return (
    <p role="status" className="assistant-notice">
      {copy.remoteChanged(
        draft.conflicts.map((key) => labels[key]?.() ?? key).join(", "),
      )}{" "}
      <button type="button" className="button secondary" onClick={draft.reload}>
        {copy.reloadLatest}
      </button>
    </p>
  );
}
