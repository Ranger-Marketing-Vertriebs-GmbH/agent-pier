import React from "react";
import { agentProjectCopy as copy } from "../../lib/i18n/messages/agent-projects.js";

// An agent's new project or its switch of the project's coding sessions, as a quiet
// line in the agent's chat (server agent-project-notes.js projectNotes).
export default function AgentProjectNote({ note }) {
  const text =
    note.change === "create"
      ? (note.coding ? copy.note.createdWithCoding : copy.note.created)(
          note.projectName,
          note.path,
        )
      : (note.coding ? copy.note.codingOn : copy.note.codingOff)(note.projectName);
  return (
    <p className="assistant-note assistant-event" data-agent-project={note.change}>
      {text}
    </p>
  );
}
