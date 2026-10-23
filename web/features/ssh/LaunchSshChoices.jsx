import React from "react";
import useSshAccesses from "./useSshAccesses.js";
import SshChoices from "./SshChoices.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import "./ssh.css";
// A shell gets only the SSH command helper; SFTP hosts need a coding CLI's tools.
export default function LaunchSshChoices({ selected, change, sftp = true }) {
  const { data, error, reload } = useSshAccesses();
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
          <SshChoices
            accesses={
              sftp ? data.accesses : data.accesses.filter(({ type }) => type !== "sftp")
            }
            selected={selected}
            change={change}
          />
          <p>{copy.launchHint}</p>
        </>
      )}
    </div>
  );
}
