import React, { useEffect, useState } from "react";
import Sheet from "../../../components/Sheet.jsx";
import Icon from "../../../components/Icon.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";
import ChatList from "./ChatList.jsx";
import ChatActionsSheet from "./ChatActionsSheet.jsx";
import "./agent-chats.css";

/**
 * The Chats sheet of one agent: New chat on top, the main chat first, then the others
 * newest first, and the archived ones behind "Archived chats" at the bottom. `chats`
 * is useAgentChats' state; `onOpen(chat)` opens one, `onCreated(chat)` a new one.
 */
export default function ChatListSheet({
  open,
  agentName,
  chats,
  currentId,
  onOpen,
  onCreated,
  onClose,
}) {
  const [acting, setActing] = useState(null);
  const [creating, setCreating] = useState(false);
  const reload = chats.reload;
  // Titles and activity change with every turn: opening the sheet reads them again.
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);
  if (!open) return null;
  const archivedView = chats.showArchived;
  const list = archivedView ? chats.archived : chats.chats;
  async function create() {
    setCreating(true);
    try {
      const chat = await chats.create();
      onCreated(chat);
    } catch {
      // The list shows the error.
    } finally {
      setCreating(false);
    }
  }
  return (
    <>
      <Sheet
        open={!acting}
        title={archivedView ? copy.showArchived : copy.showChats(agentName)}
        onCancel={onClose}
        className="agent-chats-sheet"
      >
        {!archivedView && (
          <button
            type="button"
            className="button primary agent-chats-new"
            disabled={creating}
            onClick={create}
          >
            <Icon name="plus" size={16} />
            {copy.newChat}
          </button>
        )}
        <ErrorMessage error={chats.error} />
        {list === null ? (
          <p role="status">{copy.loading}</p>
        ) : list.length ? (
          <ChatList
            chats={list}
            label={archivedView ? copy.showArchived : copy.chats}
            currentId={currentId}
            onOpen={onOpen}
            onActions={setActing}
          />
        ) : archivedView ? (
          <p className="agent-chats-empty">{copy.noArchived}</p>
        ) : null}
        <div className="sheet-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => chats.setShowArchived(!archivedView)}
          >
            {archivedView ? copy.backToChats : copy.showArchived}
          </button>
          <button type="button" className="button text" onClick={onClose}>
            {copy.close}
          </button>
        </div>
      </Sheet>
      {acting && (
        <ChatActionsSheet
          chat={acting}
          chats={chats}
          onClose={() => setActing(null)}
          onDone={(chat) => {
            setActing(null);
            // The open chat changed state: the page shows it, the list steps aside.
            if (chat.id === currentId) onClose();
          }}
        />
      )}
    </>
  );
}
