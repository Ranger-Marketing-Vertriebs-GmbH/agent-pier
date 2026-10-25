import React from "react";
import AgentEventArea from "./AgentEventArea.jsx";
import AssistantApprovalStrip from "./AssistantApprovalStrip.jsx";
import AssistantMemberContext from "./AssistantMemberContext.jsx";
import WorkGoalLine from "./WorkGoalLine.jsx";
import useOnScreenKeyboard from "./useOnScreenKeyboard.js";
import "./chat-strips.css";

/**
 * The strips under an agent chat's header: what waits for the owner, the open work
 * goal, the member's team context and the event area of routines, check-ins and
 * hooks (main chats only; the view carries `events` there). While a phone's
 * on-screen keyboard is open, the member context and the shut event area step aside
 * so the transcript keeps its room (chat-strips.css).
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
  const keyboard = useOnScreenKeyboard("assistant-message");
  return (
    <div className="assistant-chat-strips" data-keyboard={keyboard || undefined}>
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
    </div>
  );
}
