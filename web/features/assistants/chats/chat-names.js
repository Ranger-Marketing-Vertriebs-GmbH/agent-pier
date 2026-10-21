import { agentChatsCopy as copy } from "../../../lib/i18n/messages/agent-chats.js";

/** How a chat is called in lists and headers: its title, else what it is. */
export const chatTitle = (chat) =>
  chat?.title || (chat?.main ? copy.main : copy.untitled);

/**
 * Which chats the owner calls his on an agent: all of a user's own agent (he reads
 * them under her opt-in, the server lists nothing else), only his own elsewhere. A
 * user's chat on a shared agent never shows in his list.
 */
export const ownerChatFilter = (assistant) =>
  assistant.userAccess?.mode === "own" ? null : (chat) => typeof chat.userId !== "string";
