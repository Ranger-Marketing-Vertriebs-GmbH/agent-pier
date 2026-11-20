import React, { useEffect } from "react";
import GrantPicker from "../../components/GrantPicker.jsx";
import useSshAccesses from "./useSshAccesses.js";
import { launchAccesses, launchSelection } from "./ssh-launch-selection.js";
import { sshGrantEntries } from "./ssh-grant-entries.js";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { sshProjectCopy as projectCopy } from "../../lib/i18n/messages/ssh-projects.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import "./ssh.css";
// A shell gets only the SSH command helper; SFTP hosts need a coding CLI's tools.
export default function LaunchSshChoices({ selected, change, sftp = true }) {
  const { data, error, reload } = useSshAccesses();
  // Switching to a shell drops SFTP hosts already chosen, so the launch is not refused.
  useEffect(() => {
    if (!data) return;
    const kept = launchSelection(selected, data.accesses, sftp);
    if (kept !== selected) change(kept);
  }, [data, sftp, selected, change]);
  return (
    <div className="ssh-launch">
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="button" type="button" onClick={reload}>
            {commonCopy.retry}
          </button>
        </>
      ) : !data ? (
        <p role="status">{copy.loading}</p>
      ) : (
        <>
          <GrantPicker
            stacked
            entries={sshGrantEntries(launchAccesses(data.accesses, sftp), {
              copy,
              projectCopy,
            })}
            selected={selected}
            onChange={change}
            typeLabel={copy.grantType}
            listLabel={copy.title}
            heading={copy.title}
            emptyText={copy.empty}
          />
          <p>{copy.launchHint}</p>
        </>
      )}
    </div>
  );
}
