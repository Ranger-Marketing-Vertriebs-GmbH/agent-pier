import React from "react";
import TeamNote from "./TeamNote.jsx";
import AssistantMessage from "./AssistantMessage.jsx";
import CodingRunNote from "./CodingRunNote.jsx";
import SshRunNote from "./SshRunNote.jsx";
import MemberGrantNote from "./MemberGrantNote.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { routineCopy } from "../../lib/i18n/messages/assistant-routines.js";
import { memoryNoteCopy } from "../../lib/i18n/messages/assistant-memory-notes.js";
import { compactionNoteText } from "./compaction-note.js";

// One entry of the agent chat's transcript: a team note, a quiet event line or a
// message (AssistantChat.jsx). `removeShared` is null while the chat is offline.
export default function TranscriptItem({
  item: { message: m, note },
  assistant,
  navigate,
  focusedNote,
  mentions,
  removeShared,
}) {
  return note ? (
    <TeamNote note={note} navigate={navigate} focused={note.id === focusedNote} />
  ) : m.event === "coding-run" ? (
    <CodingRunNote note={m} navigate={navigate} />
  ) : m.event === "ssh-run" ? (
    <SshRunNote note={m} />
  ) : ["member-grant", "member-reminder", "member-update", "member-promote"].includes(
      m.event,
    ) ? (
    <MemberGrantNote note={m} />
  ) : m.event === "routine-failed" ? (
    <p className="assistant-note assistant-event" data-routine-failed>
      {routineCopy.chatFailed(m.name)}
      {m.notes?.includes("ssh_refused") ? ` · ${routineCopy.sshRefused}` : ""}
    </p>
  ) : m.event === "memory-note" ? (
    <p className="assistant-note assistant-event" data-memory-note={m.reason}>
      {memoryNoteCopy.reasons[m.reason] || memoryNoteCopy.unknown}
    </p>
  ) : m.event === "compaction" ? (
    <p className="assistant-note assistant-event" data-compaction-note>
      {compactionNoteText(copy, m)}
    </p>
  ) : m.role === "event" ? (
    <p className="assistant-note assistant-event">{copy.team.internalTurns[m.event]}</p>
  ) : (
    <AssistantMessage
      role={m.role}
      name={m.role === "user" ? copy.you : m.from || assistant.name}
      text={m.text}
      cut={m.cut === true}
      partial={m.partial === true}
      source={m.source}
      sender={m.sender}
      timestamp={m.timestamp}
      attachments={m.attachments}
      forwarded={m.forwarded === true}
      mentions={mentions}
      scheduled={m.scheduled || null}
      shared={m.shared === true}
      unavailable={m.unavailable === true}
      removeShared={removeShared}
    />
  );
}
