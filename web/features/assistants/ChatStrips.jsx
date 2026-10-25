import React from "react";
import AgentEventArea from "./AgentEventArea.jsx";
import AssistantApprovalStrip from "./AssistantApprovalStrip.jsx";
import AssistantMemberContext from "./AssistantMemberContext.jsx";
import WorkGoalLine from "./WorkGoalLine.jsx";

/**
 * The strips under an agent chat's header: what waits for the owner, the open work
 * goal, the member's team context and the event area of routines, check-ins and
 * hooks (main chats only; the view carries `events` there).
 */
export default function ChatStrips({
  entry,
  output,
  stick,
  history,
  conversationId,
  assistant,
  member,
  navigate,
  onStopped,
}) {
  return (
    <>
      <AssistantApprovalStrip
        count={entry.pendingApprovals}
        output={output}
        stick={stick}
      />
      <WorkGoalLine
        goal={history.goal}
        conversationId={conversationId}
        onStopped={onStopped}
      />
      {member && <AssistantMemberContext member={member} navigate={navigate} />}
      <AgentEventArea
        assistantId={assistant.id}
        conversationId={conversationId}
        events={history.events}
        navigate={navigate}
      />
    </>
  );
}
