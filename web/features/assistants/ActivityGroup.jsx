import React from "react";
import ActivityRow from "../../components/ActivityRow.jsx";
import SshRunNote from "./SshRunNote.jsx";
import { activityGroupView } from "./activity-groups.js";

// Consecutive tool calls of an agent turn as one activity row, shut by default; it
// opens to the calls' own rows (activity-groups.js).
export default function ActivityGroup({ messages }) {
  const view = activityGroupView(messages);
  return (
    <ActivityRow
      className="activity-group"
      data-activity-group={messages.length}
      data-failed={view.failed || undefined}
      data-running={view.running || undefined}
      label={view.label}
      detail={view.detail}
      status={view.status}
      tone={view.tone}
    >
      {messages.map((message) => (
        <SshRunNote key={message.id} note={message} />
      ))}
    </ActivityRow>
  );
}
