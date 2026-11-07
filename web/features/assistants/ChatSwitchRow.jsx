import React from "react";
import Icon from "../../components/Icon.jsx";
import Segmented from "../../components/Segmented.jsx";
import { agentChatsCopy } from "../../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy as copy } from "../../lib/i18n/messages/agent-pinboard.js";
import SummariseNowButton from "./chats/SummariseNowButton.jsx";

/**
 * The one row under the agent chat's header on phones and in split-view panes: the
 * Chat | Pinboard switch (`fresh` counts the changed files), then the Chats sheet,
 * New chat and Summarize now as icon buttons. `tab` is "chat" or "pinboard"; `onTab`
 * null hides the switch (a user's own agent has no pinboard), `onChats` / `onNewChat`
 * null hide their button (a team member has one chat; a user's agent's chats are
 * hers). `summarise` is SummariseNowButton's `{ run, reason }`.
 */
export default function ChatSwitchRow({
  assistant,
  tab,
  onTab,
  fresh = 0,
  summarise,
  onChats,
  onNewChat,
}) {
  return (
    <div className="agent-chat-switch">
      {onTab && (
        <Segmented
          label={copy.switchLabel}
          className="agent-chat-switch-tabs"
          value={tab}
          onChange={onTab}
          options={[
            { value: "chat", label: copy.chat },
            {
              value: "pinboard",
              label: (
                <>
                  <Icon name="pin" size={14} />
                  {copy.tabWithCount(fresh)}
                </>
              ),
            },
          ]}
        />
      )}
      <span className="agent-chat-switch-actions">
        {onChats && (
          <button
            type="button"
            className="icon-button"
            aria-label={agentChatsCopy.chats}
            title={agentChatsCopy.showChats(assistant.name)}
            aria-haspopup="dialog"
            onClick={onChats}
          >
            <Icon name="history" />
          </button>
        )}
        {onNewChat && (
          <button
            type="button"
            className="icon-button"
            aria-label={agentChatsCopy.newChat}
            title={agentChatsCopy.newChat}
            disabled={!!assistant.archivedAt}
            onClick={onNewChat}
          >
            <Icon name="plus" />
          </button>
        )}
        {summarise && <SummariseNowButton {...summarise} />}
      </span>
    </div>
  );
}
