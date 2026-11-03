import React, { memo } from "react";
import TeamApprovals from "./TeamApprovals.jsx";
import AssistantActionApprovals from "./AssistantActionApprovals.jsx";
import MemoryReviews from "./MemoryReviews.jsx";
import GoAheadButton from "./GoAheadButton.jsx";

// Streamed deltas re-render the chat on every token; the team approvals do not need to.
const PendingTeams = memo(TeamApprovals);

/**
 * What waits for the owner under the transcript: the go-ahead after a refused change,
 * the lead's pending team approvals, the owner's memory review after a model switch
 * and the agent's own action requests.
 */
export default function AssistantChatActions({
  assistant,
  member,
  conversationId,
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
      {!member && <MemoryReviews conversationId={conversationId} />}
      <AssistantActionApprovals
        {...ownActions}
        assistant={assistant}
        go={navigate}
        notedMail={notedMail}
      />
    </>
  );
}
