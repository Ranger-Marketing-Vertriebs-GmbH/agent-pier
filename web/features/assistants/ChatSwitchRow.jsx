import React from "react";
import Icon from "../../components/Icon.jsx";
import Segmented from "../../components/Segmented.jsx";
import { agentChatsCopy } from "../../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy as copy } from "../../lib/i18n/messages/agent-pinboard.js";

/**
 * The one row under the agent chat's header on phones and in split-view panes: the
 * Chat | Pinboard switch (`fresh` counts the changed files), then Chats, which opens
 * the Chats sheet (New chat, Summarize this chat, the list). `tab` is "chat" or
 * "pinboard"; `onTab` null hides the switch (a user's own agent has no pinboard).
 */
export default function ChatSwitchRow({ assistant, tab, onTab, fresh = 0, onChats }) {
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
      <button
        type="button"
        className="button secondary compact agent-chat-switch-chats"
        title={agentChatsCopy.showChats(assistant.name)}
        aria-haspopup="dialog"
        onClick={onChats}
      >
        <Icon name="chats" size={16} />
        {agentChatsCopy.chats}
      </button>
    </div>
  );
}
