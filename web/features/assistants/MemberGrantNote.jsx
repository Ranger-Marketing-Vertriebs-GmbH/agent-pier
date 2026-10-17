import React from "react";
import { memberGrantCopy as copy } from "../../lib/i18n/messages/assistant-member-grants.js";
import { keyLabels } from "./member-grants.js";

// A lead's grant to a team member, or the owner's decision on one, as a quiet line in
// the member's and the lead's chats (server member-grant-notes.js grantNotes).
export default function MemberGrantNote({ note }) {
  const labels = keyLabels(note.revoked || note.granted, note.mcpServers, note.shell);
  const text =
    note.by === "owner"
      ? (copy.note[note.state] || copy.note.completed)(note.memberName, labels)
      : note.revoked
        ? copy.note.revoked(note.memberName, labels)
        : copy.note.granted(note.memberName, labels);
  return (
    <p className="assistant-note assistant-event" data-member-grant={note.state}>
      {text}
    </p>
  );
}
