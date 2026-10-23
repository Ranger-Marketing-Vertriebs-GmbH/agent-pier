import React from "react";
import ActivityGroup from "../../components/ActivityGroup.jsx";
import SshRunNote from "./SshRunNote.jsx";
import { activityGroupView } from "./activity-groups.js";

// Consecutive SSH runs of an agent turn as one activity group (activity-groups.js).
export default function SshActivityGroup({ messages }) {
  return (
    <ActivityGroup data-activity-group={messages.length} {...activityGroupView(messages)}>
      {messages.map((message) => (
        <SshRunNote key={message.id} note={message} />
      ))}
    </ActivityGroup>
  );
}
