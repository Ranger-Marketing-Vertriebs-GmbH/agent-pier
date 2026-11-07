import React from "react";
import ChatListSheet from "./ChatListSheet.jsx";
import { chatTitle } from "./chat-names.js";
import { ChatTitleButton } from "./ChatStates.jsx";

/**
 * The open chat's title in the agent chat header's status line ("Dinner plans ▾"),
 * which opens the Chats sheet. `owner` is useOwnerChats' result. A user's own agent's
 * chats are hers: the owner reads them under her opt-in, never starts or changes one.
 */
export default function OwnerChatSelector({ assistant, conversationId, owner }) {
  const readOnly = assistant.userAccess?.mode === "own";
  return (
    <>
      <ChatTitleButton
        title={owner.chat ? chatTitle(owner.chat) : "…"}
        agentName={assistant.name}
        onClick={() => owner.setOpen(true)}
      />
      <ChatListSheet
        open={owner.open}
        agentName={assistant.name}
        chats={owner.chats}
        currentId={conversationId}
        onOpen={(c) => owner.go(c)}
        onCreated={(c) => owner.go(c, true)}
        onClose={() => owner.setOpen(false)}
        readOnly={readOnly}
      />
    </>
  );
}
