import React from "react";
import ActivityRow from "../../components/ActivityRow.jsx";
import { assistantMailCopy } from "../../lib/i18n/messages/assistant-mail.js";
import SshCommandText from "./SshCommandText.jsx";

// The final states a note names (server mailNotes); anything else reads as unknown.
const finalStates = new Set([
  "completed",
  "declined",
  "expired",
  "cancelled",
  "failed",
  "unknown",
]);
const tones = {
  completed: "ok",
  failed: "error",
  unknown: "error",
};

// An agent's email card that reached its final state (server mailNotes) as an
// activity row: the subject and the card's state; opening it shows the email account,
// how many recipients and, when it did not go out as asked, the code. Never the
// body or an address.
export default function MailRunNote({ note }) {
  const { card, note: t } = assistantMailCopy;
  const state = finalStates.has(note.state) ? note.state : "unknown";
  return (
    <ActivityRow
      className="mail-run-note"
      data-mail-run={state}
      icon="inbox"
      label={t.label}
      detail={note.subject ? <SshCommandText command={note.subject} /> : card.noSubject}
      status={card.states[state]}
      tone={tones[state] || "neutral"}
    >
      <dl className="activity-row-facts">
        <dt>{t.account}</dt>
        <dd>{note.accountName}</dd>
        <dt>{t.recipients}</dt>
        <dd>{note.recipientCount}</dd>
        {note.code && (
          <>
            <dt>{t.code}</dt>
            <dd>
              <code>{note.code}</code>
            </dd>
          </>
        )}
      </dl>
    </ActivityRow>
  );
}
