import React, { useMemo, useState } from "react";
import Icon from "../../../components/Icon.jsx";
import useAssistants from "../useAssistants.js";
import useAgentChats, { ownerChatApi } from "./useAgentChats.js";
import ChatListSheet from "./ChatListSheet.jsx";
import { chatTitle, ownerChatFilter } from "./chat-names.js";
import { ChatTitleButton } from "./ChatStates.jsx";
import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";

/**
 * The bar under the owner's agent chat header (AGENTPIER-181): the chat's title, which
 * opens the Chats sheet, and New chat. His list follows the agent list's changes of
 * this agent's chats; an archived or deleted chat leaves the offline cache. A user's
 * own agent's chats are hers: he reads them under her opt-in, never writes or starts one.
 */
export default function OwnerChatBar({ assistant, conversationId, navigate }) {
  const { conversations = [], histories, refresh } = useAssistants();
  const [open, setOpen] = useState(false);
  const mine = conversations.filter((c) => c.assistantId === assistant.id);
  const version = mine.map((c) => `${c.id}:${c.title}:${c.archivedAt}`).join();
  const filter = useMemo(() => ownerChatFilter(assistant), [assistant]);
  const chats = useAgentChats(ownerChatApi, assistant.id, {
    version,
    filter,
    onChanged: (chat, kind) => {
      if (kind !== "restored") histories?.drop(chat.id);
      refresh();
    },
  });
  const go = async (chat, created = false) => {
    setOpen(false);
    // A new chat joins the agent list first, so its page finds it.
    if (created) await refresh();
    navigate({ view: "agents", assistantId: assistant.id, conversationId: chat.id });
  };
  const chat =
    chats.chats?.find((c) => c.id === conversationId) ||
    chats.archived?.find((c) => c.id === conversationId) ||
    mine.find((c) => c.id === conversationId);
  if (assistant.teamMemberId) return null;
  const readOnly = assistant.userAccess?.mode === "own";
  return (
    <div className="agent-chat-bar">
      <ChatTitleButton
        title={chat ? chatTitle(chat) : "…"}
        agentName={assistant.name}
        onClick={() => setOpen(true)}
      />
      {!readOnly && (
        <button
          type="button"
          className="button secondary compact agent-chat-new"
          disabled={!!assistant.archivedAt}
          onClick={async () => {
            try {
              go(await chats.create(), true);
            } catch {
              setOpen(true);
            }
          }}
        >
          <Icon name="plus" size={14} />
          {copy.newChat}
        </button>
      )}
      <ChatListSheet
        open={open}
        agentName={assistant.name}
        chats={chats}
        currentId={conversationId}
        onOpen={(c) => go(c)}
        onCreated={(c) => go(c, true)}
        onClose={() => setOpen(false)}
        readOnly={readOnly}
      />
    </div>
  );
}
