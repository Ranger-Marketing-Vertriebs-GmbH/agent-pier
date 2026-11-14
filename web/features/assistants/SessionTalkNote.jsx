import React from "react";
import ChatTime from "./ChatTime.jsx";
import { sessionTalkCopy } from "../../lib/i18n/messages/session-talk.js";

const copy = sessionTalkCopy.chat;

// What an agent's session tools did, as a quiet line in its chat (server
// session-talk/talk-notes.js): a message it wrote to a session, a late answer, or a
// budget limit. Asks and tells from a session show as that session's turn instead.
export default function SessionTalkNote({ note }) {
  const project = note.projectName || copy.noProject;
  const head =
    note.op === "limit"
      ? copy.limit(note.sessionName)
      : note.op === "late"
        ? note.outcome === "dropped"
          ? copy.lateDropped(note.sessionName)
          : copy.lateTo(note.sessionName, project)
        : copy.sentTo(note.sessionName, project);
  const outcome = note.op === "send" && note.outcome ? copy.outcome[note.outcome] : null;
  return (
    <p className="assistant-note assistant-event" data-session-talk={note.op}>
      {head}
      {outcome && ` · ${outcome}`}
      {note.text && ` · “${note.text}”`}
      {note.timestamp > 0 && " · "}
      <ChatTime timestamp={note.timestamp} />
    </p>
  );
}
