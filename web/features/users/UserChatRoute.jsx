import React, { useEffect, useState } from "react";
import useAgentChats from "../assistants/chats/useAgentChats.js";
import ChatListSheet from "../assistants/chats/ChatListSheet.jsx";
import { chatTitle } from "../assistants/chats/chat-names.js";
import {
  ArchivedChatBanner,
  ChatTitleButton,
  DeletedChat,
} from "../assistants/chats/ChatStates.jsx";
import UserChat from "./UserChat.jsx";
import UserHeader from "./UserHeader.jsx";
import { UserPage } from "./UserPage.jsx";
import { userChatApi } from "./user-api.js";

/**
 * A user's chat with her chat list (AGENTPIER-181): the header's title opens her
 * Chats sheet with New chat; an archived chat opens read-only with Restore, and a
 * deleted one (a push notice's old link) says so and leads to her main chat. Only
 * her own chats show, also on a shared agent: the server lists no one else's.
 */
export default function UserChatRoute({
  agent,
  conversationId,
  navigate,
  histories,
  subscribe,
  ownerMayRead,
}) {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "chats" && event.agentId === agent.id)
          setVersion((n) => n + 1);
      }),
    [subscribe, agent.id],
  );
  const chats = useAgentChats(userChatApi, agent.id, {
    version,
    onChanged: (chat, kind) => {
      if (kind !== "restored") histories.drop(chat.id);
    },
  });
  const go = (chat) => {
    setOpen(false);
    navigate({ view: "chat", agentId: agent.id, conversationId: chat.id });
  };
  const current = chats.chats?.find((c) => c.id === conversationId);
  const archived = chats.archived?.find((c) => c.id === conversationId);
  const main = chats.chats?.find((c) => c.main);
  if (chats.chats && chats.archived && !current && !archived)
    return (
      <UserPage
        header={
          <UserHeader
            title={agent.name}
            onBack={() => navigate({ view: "agents" })}
            navigate={navigate}
          />
        }
      >
        <DeletedChat onMain={main ? () => go(main) : null} />
      </UserPage>
    );
  const chat = current || archived;
  return (
    <>
      <UserChat
        agent={agent}
        conversationId={conversationId}
        navigate={navigate}
        histories={histories}
        subscribe={subscribe}
        ownerMayRead={ownerMayRead}
        readOnly={Boolean(archived)}
        banner={
          archived ? (
            <ArchivedChatBanner onRestore={() => chats.restore(archived)} />
          ) : null
        }
        chatSwitch={
          <ChatTitleButton
            title={chat ? chatTitle(chat) : "…"}
            agentName={agent.name}
            onClick={() => setOpen(true)}
          />
        }
      />
      <ChatListSheet
        open={open}
        agentName={agent.name}
        chats={chats}
        currentId={conversationId}
        onOpen={go}
        onCreated={go}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
