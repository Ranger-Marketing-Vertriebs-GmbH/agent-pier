import React from "react";
import useSshAccesses from "./useSshAccesses.js";
import SshChoices from "./SshChoices.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";
import "./ssh.css";
export default function LaunchSshChoices({ selected, change }) {
  const { data, error, reload } = useSshAccesses();
  return (
    <div className="ssh-launch">
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button className="button" type="button" onClick={reload}>
            {copy.retry}
          </button>
        </>
      ) : !data ? (
        <p role="status">{copy.loading}</p>
      ) : (
        <>
          <SshChoices accesses={data.accesses} selected={selected} change={change} />
          <p>{copy.launchHint}</p>
        </>
      )}
    </div>
  );
}
