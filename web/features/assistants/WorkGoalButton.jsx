import React, { useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import Sheet from "../../components/Sheet.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { agentChatsCopy } from "../../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy } from "../../lib/i18n/messages/agent-pinboard.js";
import { workGoalCopy } from "../../lib/i18n/messages/work-goals.js";
import useStopGoal from "./useStopGoal.js";

/**
 * The chat's open work goal (AGENTPIER-208) as a header icon: a working dot and the
 * stop glyph. A tap opens a sheet with the goal and the owner's Stop. `onStopped`
 * reloads the chat. Nothing without a goal.
 */
export default function WorkGoalButton({ goal, conversationId, onStopped }) {
  const [open, setOpen] = useState(false);
  const { stop, stopping, failed } = useStopGoal(conversationId, onStopped);
  if (!goal) return null;
  const text = workGoalCopy.line(goal.title);
  return (
    <>
      <button
        type="button"
        className="assistant-header-icon agent-chat-work"
        aria-label={text}
        title={text}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <StatusDot tone="working" pulse />
        <Icon name="stop" size={12} />
      </button>
      <Sheet
        open={open}
        title={agentPinboardCopy.header.workSheet}
        onCancel={() => setOpen(false)}
      >
        <p className="sheet-body agent-chat-work-goal" role="status">
          {text}
        </p>
        <ErrorMessage error={failed && workGoalCopy.stopFailed} />
        <div className="sheet-actions">
          <button
            type="button"
            className="button danger"
            disabled={stopping}
            onClick={async () => {
              if (await stop()) setOpen(false);
            }}
          >
            {workGoalCopy.stop}
          </button>
          <button type="button" className="button text" onClick={() => setOpen(false)}>
            {agentChatsCopy.close}
          </button>
        </div>
      </Sheet>
    </>
  );
}
