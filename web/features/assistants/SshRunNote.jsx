import React from "react";
import { assistantSshCopy as copy } from "../../lib/i18n/messages/assistant-ssh.js";
import SshCommandText from "./SshCommandText.jsx";
import { sshOutcomeText, sshSeconds } from "./ssh-run-note.js";

// A command an agent ran over SSH, as a quiet line in its chat (server actionNotes).
export default function SshRunNote({ note }) {
  const duration =
    note.durationMs != null ? copy.note.duration(sshSeconds(note.durationMs)) : "";
  return (
    <p
      className="assistant-note assistant-event ssh-run-note"
      data-ssh-run={note.outcome}
      title={duration || undefined}
    >
      {copy.note.lead(note.hostName)}{" "}
      <code>
        <SshCommandText command={note.commandPreview} />
      </code>{" "}
      · {sshOutcomeText(note.outcome, note.exitCode)}
      {duration && <span className="sr-only"> ({duration})</span>}
    </p>
  );
}
