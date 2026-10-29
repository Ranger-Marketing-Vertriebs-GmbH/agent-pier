import React, { useId } from "react";
import Icon from "../../../components/Icon.jsx";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";

/**
 * Summarize now in the owner's chat bar, at any time (AGENTPIER-263): the same action
 * as the long-chat hint's button. `reason` is why it cannot run now (it stays visible as
 * the tooltip and is announced); empty when it can. On a phone only the icon shows.
 */
export default function SummariseNowButton({ run, reason = "" }) {
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        className="button secondary compact agent-chat-summarise"
        disabled={Boolean(reason)}
        title={reason || undefined}
        aria-describedby={reason ? reasonId : undefined}
        aria-label={copy.summariseNow}
        onClick={run}
      >
        <Icon name="history" size={14} />
        <span className="agent-chat-summarise-label">{copy.summariseNow}</span>
      </button>
      {reason && (
        <span id={reasonId} className="visually-hidden">
          {reason}
        </span>
      )}
    </>
  );
}
