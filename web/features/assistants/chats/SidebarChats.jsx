import React from "react";
import { chatTitle } from "./chat-names.js";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";
import "./agent-chats.css";

/**
 * Under the open agent in the sidebar: its recent chats, the main chat pinned first
 * (AGENTPIER-181). Shown only when there is more than the main chat.
 */
export default function SidebarChats({ chats, currentId, onOpen }) {
  if (chats.length < 2) return null;
  return (
    <div className="assistant-sidebar-chats" role="group" aria-label={copy.chats}>
      {chats.map((chat) => (
        <button
          key={chat.id}
          type="button"
          className={`session-item assistant-sidebar-chat${chat.id === currentId ? " selected" : ""}`}
          aria-current={chat.id === currentId ? "page" : undefined}
          onClick={() => onOpen(chat)}
        >
          <span>{chatTitle(chat)}</span>
          {chat.main && chat.title && <small>{copy.main}</small>}
        </button>
      ))}
    </div>
  );
}
