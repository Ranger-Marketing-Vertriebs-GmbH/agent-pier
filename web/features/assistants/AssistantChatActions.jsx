import React, { memo } from "react";
import TeamApprovals from "./TeamApprovals.jsx";
import AssistantActionApprovals from "./AssistantActionApprovals.jsx";
import GoAheadButton from "./GoAheadButton.jsx";

// Streamed deltas re-render the chat on every token; the team approvals do not need to.
const PendingTeams = memo(TeamApprovals);

/**
 * What waits for the owner under the transcript: the go-ahead after a refused change,
 * the lead's pending team approvals and the agent's own action requests.
 */
export default function AssistantChatActions({
  assistant,
  member,
  latest,
  available,
  busy,
  onSend,
  navigate,
  pushedActions,
  ownActions,
  notedMail,
}) {
  return (
    <>
      <GoAheadButton latest={latest} available={available} busy={busy} onSend={onSend} />
      {!member && (
        <PendingTeams assistant={assistant} navigate={navigate} pushed={pushedActions} />
      )}
      <AssistantActionApprovals
        {...ownActions}
        assistant={assistant}
        go={navigate}
        notedMail={notedMail}
      />
    </>
  );
}
