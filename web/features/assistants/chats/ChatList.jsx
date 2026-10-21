import React from "react";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { formatMessageTime } from "../../../lib/i18n/index.js";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";

/** How a chat is called in lists and headers: its title, else what it is. */
export const chatTitle = (chat) =>
  chat?.title || (chat?.main ? copy.main : copy.untitled);

const subline = (chat) =>
  [
    chat.busy ? copy.busy : "",
    chat.lastActivityAt
      ? copy.lastActive(formatMessageTime(Date.parse(chat.lastActivityAt)))
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * Rows of chats: a tap opens one, ⋯ opens its actions (ChatActionsSheet). The main
 * chat carries the "Main chat" badge; the open chat is marked current.
 */
export default function ChatList({ chats, label, currentId, onOpen, onActions }) {
  return (
    <ListCard label={label} className="agent-chat-list">
      {chats.map((chat) => (
        <ListRow
          key={chat.id}
          label={chatTitle(chat)}
          sub={subline(chat)}
          value={
            chat.main && chat.title
              ? copy.main
              : chat.archivedAt
                ? copy.archived
                : undefined
          }
          current={chat.id === currentId}
          chevron={false}
          onClick={() => onOpen(chat)}
          menu={
            onActions && {
              label: copy.actionsFor(chatTitle(chat)),
              onClick: () => onActions(chat),
            }
          }
        />
      ))}
    </ListCard>
  );
}
