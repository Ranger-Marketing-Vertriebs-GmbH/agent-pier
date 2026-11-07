import React from "react";
import AssistantApprovalStrip from "./AssistantApprovalStrip.jsx";
import AssistantMemberContext from "./AssistantMemberContext.jsx";
import PreviewStrip from "../previews/PreviewStrip.jsx";
import useOnScreenKeyboard from "./useOnScreenKeyboard.js";
import { usePaneId } from "../../lib/pane-context.js";
import "./chat-strips.css";

/**
 * The strips under an agent chat's header: what waits for the owner, the previews the
 * agent opened for the chat and the member's team context. The work goal and the
 * events sit in the header (WorkGoalButton, AgentEventsButton). While a phone's
 * on-screen keyboard is open, the member context and the previews step aside so the
 * transcript keeps its room (chat-strips.css).
 */
export default function ChatStrips({
  entry,
  output,
  stick,
  conversationId,
  member,
  navigate,
}) {
  const keyboard = useOnScreenKeyboard(usePaneId("assistant-message"));
  return (
    <div className="assistant-chat-strips" data-keyboard={keyboard || undefined}>
      <AssistantApprovalStrip
        count={entry.pendingApprovals}
        output={output}
        stick={stick}
      />
      <PreviewStrip conversationId={conversationId} />
      {member && <AssistantMemberContext member={member} navigate={navigate} />}
    </div>
  );
}
