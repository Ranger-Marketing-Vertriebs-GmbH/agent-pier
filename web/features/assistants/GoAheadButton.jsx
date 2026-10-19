import React from "react";
import { goAheadCopy as copy } from "../../lib/i18n/messages/lead-shares.js";

/**
 * The owner's one tap after the lead agent was refused a change while it handled a
 * member's result (server conversations.js goAheadMarks): it sends a real owner
 * message, so nobody has to type the yes. Shown only below that follow-up's reply,
 * while nothing newer was sent and the chat can take a message.
 */
export default function GoAheadButton({ latest, available, busy, onSend }) {
  const settled = latest?.attempt?.state === "completed" && !latest.attempt.reviewedAt;
  if (latest?.internal !== "member-result" || !latest.goAhead || !settled || !available)
    return null;
  return (
    <div className="assistant-go-ahead" data-go-ahead="">
      <p className="assistant-note">{copy.hint}</p>
      <button
        type="button"
        className="button primary"
        disabled={busy}
        onClick={() => onSend(copy.message)}
      >
        {copy.button}
      </button>
    </div>
  );
}
