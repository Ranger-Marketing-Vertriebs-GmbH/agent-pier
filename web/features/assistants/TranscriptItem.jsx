import React from "react";
import ChatTime from "./ChatTime.jsx";
import TeamNote from "./TeamNote.jsx";
import AssistantMessage from "./AssistantMessage.jsx";
import CodingRunNote from "./CodingRunNote.jsx";
import SshRunNote from "./SshRunNote.jsx";
import SftpRunNote from "./SftpRunNote.jsx";
import RemoteActivityGroup from "./RemoteActivityGroup.jsx";
import MemberGrantNote from "./MemberGrantNote.jsx";
import WorkGoalNote from "./WorkGoalNote.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { routineCopy } from "../../lib/i18n/messages/assistant-routines.js";
import { memoryNoteCopy } from "../../lib/i18n/messages/assistant-memory-notes.js";
import { leadRequestCopy } from "../../lib/i18n/messages/lead-requests.js";
import { compactionNoteText } from "./compaction-note.js";
import { failureText } from "./routine-failure-text.js";

// Quiet notes join the history between turns (AssistantChat.jsx).
export const noteEvents = new Set([
  "compaction",
  "memory-note",
  "routine-failed",
  "coding-run",
  "peer-request",
  "goal",
]);

// One entry of the agent chat's transcript: a team note, a group of activity rows
// (activity-groups.js), a quiet event line or a message (AssistantChat.jsx).
// `removeShared` is null while the chat is offline.
export default function TranscriptItem({
  item: { message: m, note, activity },
  assistant,
  navigate,
  focusedNote,
  mentions,
  removeShared,
}) {
  return activity ? (
    <RemoteActivityGroup messages={activity} />
  ) : note ? (
    <TeamNote note={note} navigate={navigate} focused={note.id === focusedNote} />
  ) : m.event === "coding-run" ? (
    <CodingRunNote note={m} navigate={navigate} />
  ) : m.event === "goal" || m.event === "goal-continuation" ? (
    <WorkGoalNote note={m} />
  ) : m.event === "ssh-run" ? (
    <SshRunNote note={m} />
  ) : m.event === "sftp-run" ? (
    <SftpRunNote note={m} />
  ) : [
      "member-grant",
      "member-reminder",
      "member-update",
      "member-promote",
      "member-summarise",
    ].includes(m.event) ? (
    <MemberGrantNote note={m} />
  ) : m.event === "routine-failed" ? (
    <p className="assistant-note assistant-event" data-routine-failed>
      {m.kind === "reminder"
        ? routineCopy.reminderFailed(m.name)
        : routineCopy.chatFailed(m.name)}
      {m.failure ? ` · ${failureText(m.failure)}` : ""}
      {m.notes?.includes("ssh_refused") ? ` · ${routineCopy.sshRefused}` : ""}
    </p>
  ) : m.event === "memory-note" ? (
    <p className="assistant-note assistant-event" data-memory-note={m.reason}>
      {memoryNoteCopy.reasons[m.reason] || memoryNoteCopy.unknown}
    </p>
  ) : m.event === "peer-request" ? (
    <p className="assistant-note assistant-event" data-peer-note={m.phase}>
      {leadRequestCopy.peerNote[m.phase]?.(m.type, m.from, m.to)}
      {m.timestamp > 0 && " · "}
      <ChatTime timestamp={m.timestamp} />
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
