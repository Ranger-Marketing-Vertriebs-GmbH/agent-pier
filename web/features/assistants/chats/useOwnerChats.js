import { useMemo, useState } from "react";
import useAssistants from "../useAssistants.js";
import useAgentChats, { ownerChatApi } from "./useAgentChats.js";
import { ownerChatFilter } from "./chat-names.js";

/**
 * The owner's chats with one agent (AGENTPIER-181): the open chat (`chat`), the Chats
 * sheet's state (`chats`, `open`, `setOpen`), `go(chat, created?)`, which opens a chat,
 * and `create()`, which starts one and opens it (the sheet on failure, where the list
 * shows the error). The list follows the agent list's changes of this agent's chats;
 * an archived or deleted chat leaves the offline cache.
 */
export default function useOwnerChats(assistant, conversationId, navigate) {
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
  const create = async () => {
    try {
      await go(await chats.create(), true);
    } catch {
      setOpen(true);
    }
  };
  const chat =
    chats.chats?.find((c) => c.id === conversationId) ||
    chats.archived?.find((c) => c.id === conversationId) ||
    mine.find((c) => c.id === conversationId) ||
    null;
  return { chat, chats, open, setOpen, go, create };
}
