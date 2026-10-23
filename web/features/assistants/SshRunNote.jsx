import React from "react";
import ActivityRow from "../../components/ActivityRow.jsx";
import CodeBlock from "../../components/CodeBlock.jsx";
import { assistantSshCopy as copy } from "../../lib/i18n/messages/assistant-ssh.js";
import SshCommandText from "./SshCommandText.jsx";
import { sshRunView } from "./ssh-run-note.js";

// A command an agent ran over SSH (server actionNotes) as an activity row: host,
// shortened command and outcome; opening it shows the full command to copy and the
// facts the note records (the output stays with the agent).
export default function SshRunNote({ note }) {
  const view = sshRunView(note);
  const t = copy.note;
  return (
    <ActivityRow
      className="ssh-run-note"
      data-ssh-run={note.outcome}
      label={view.label}
      detail={<SshCommandText command={view.preview} />}
      status={view.status}
      tone={view.tone}
    >
      <CodeBlock
        className="activity-row-code"
        aria-label={t.command}
        copyText={view.copyText}
        copyLabel={t.copy}
      >
        <code>
          <SshCommandText command={view.command} />
        </code>
      </CodeBlock>
      {view.redacted && (
        <p className="activity-row-note" data-command-redacted>
          {t.redacted}
        </p>
      )}
      {view.partial && <p className="activity-row-note">{t[view.partial]}</p>}
      <dl className="activity-row-facts">
        {view.exitCode != null && (
          <>
            <dt>{t.exitCode}</dt>
            <dd>{view.exitCode}</dd>
          </>
        )}
        {view.duration && (
          <>
            <dt>{t.duration}</dt>
            <dd>{view.duration}</dd>
          </>
        )}
        {view.result && (
          <>
            <dt>{t.result}</dt>
            <dd>{view.result}</dd>
          </>
        )}
      </dl>
    </ActivityRow>
  );
}
