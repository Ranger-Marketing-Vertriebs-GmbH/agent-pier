import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";

// The owner removes a file an agent shared from AgentPier, after one confirmation.
// `remove(file)` resolves once the server deleted it; a failure says why.
export default function SharedFileDelete({ file, remove }) {
  const [state, setState] = useState("idle");
  const [error, setError] = useState("");
  if (state === "idle")
    return (
      <button
        type="button"
        className="button secondary agent-shared-delete"
        aria-label={copy.deleteShared(file.name)}
        onClick={() => setState("confirm")}
      >
        <Icon name="trash" size={14} />
        <span aria-hidden="true">{copy.deleteLabel}</span>
      </button>
    );
  return (
    <div
      className="agent-shared-confirm"
      role="group"
      aria-label={copy.deleteShared(file.name)}
    >
      <p>{copy.deleteConfirm(file.name)}</p>
      <div className="assistant-actions">
        <button
          type="button"
          className="button danger"
          disabled={state === "busy"}
          onClick={async () => {
            setState("busy");
            setError("");
            try {
              await remove(file);
            } catch (e) {
              setError(e.message);
              setState("confirm");
            }
          }}
        >
          {copy.deleteYes}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={state === "busy"}
          onClick={() => setState("idle")}
        >
          {copy.deleteNo}
        </button>
      </div>
      {error && <p className="agent-attachments-error">{error}</p>}
    </div>
  );
}
