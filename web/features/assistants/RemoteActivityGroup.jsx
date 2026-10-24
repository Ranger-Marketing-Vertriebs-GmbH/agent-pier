import React from "react";
import ActivityGroup from "../../components/ActivityGroup.jsx";
import SshRunNote from "./SshRunNote.jsx";
import SftpRunNote from "./SftpRunNote.jsx";
import { activityGroupView } from "./activity-groups.js";

// Consecutive SSH runs and SFTP jobs of an agent turn as one activity group
// (activity-groups.js).
export default function RemoteActivityGroup({ messages }) {
  return (
    <ActivityGroup data-activity-group={messages.length} {...activityGroupView(messages)}>
      {messages.map((message) =>
        message.event === "sftp-run" ? (
          <SftpRunNote key={message.id} note={message} />
        ) : (
          <SshRunNote key={message.id} note={message} />
        ),
      )}
    </ActivityGroup>
  );
}
