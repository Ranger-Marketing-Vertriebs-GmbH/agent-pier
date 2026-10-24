import React from "react";
import ActivityRow from "../../components/ActivityRow.jsx";
import SshCommandText from "./SshCommandText.jsx";
import { sftpRunView } from "./sftp-run-note.js";

// An agent's SFTP job (server actionNotes) as an activity row: operation, host and
// remote path with the state's chip (a running job's progress, updated live);
// opening it shows the paths, counts, bytes, duration and, when it failed, its code.
// Hidden characters in a path appear as code badges.
export default function SftpRunNote({ note }) {
  const view = sftpRunView(note);
  return (
    <ActivityRow
      className="sftp-run-note"
      data-sftp-run={note.state}
      icon={view.icon}
      label={view.label}
      detail={<SshCommandText command={view.detail ?? ""} />}
      status={view.status}
      tone={view.tone}
    >
      <dl className="activity-row-facts">
        {view.facts.map(([term, value]) => (
          <React.Fragment key={term}>
            <dt>{term}</dt>
            <dd>
              <SshCommandText command={value} />
            </dd>
          </React.Fragment>
        ))}
      </dl>
    </ActivityRow>
  );
}
