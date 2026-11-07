import React, { useId } from "react";
import Icon from "../../../components/Icon.jsx";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";

/**
 * Summarize this chat in the Chats sheet, under New chat, at any time (AGENTPIER-263):
 * the same action as the long-chat hint's button, which asks first
 * (SummariseConfirm.jsx). `reason` is why it cannot run now, shown under it; empty
 * when it can. `onRun` runs first (the sheet closes, so the question shows).
 */
export default function SummariseNowButton({ run, reason = "", onRun }) {
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        className="button secondary agent-chats-summarise"
        disabled={Boolean(reason)}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => {
          onRun?.();
          run();
        }}
      >
        <Icon name="summarise" size={16} />
        {copy.summariseThisChat}
      </button>
      {reason && (
        <p id={reasonId} className="agent-chats-reason">
          {reason}
        </p>
      )}
    </>
  );
}
