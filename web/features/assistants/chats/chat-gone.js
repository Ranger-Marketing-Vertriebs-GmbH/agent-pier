/**
 * Whether a chat link points at a chat that is gone (a push notice's, another tab
 * deleted it). The agent's other chats are known by then (its main chat is never
 * deleted); a list without any yet may still be catching up with a chat just opened.
 * A user's own agent has no chat of the owner's: one the owner cannot list is one the
 * owner may not read.
 */
export function chatGone({ assistant, conversationId, conversations = [] }) {
  if (!conversationId || !assistant) return false;
  if (conversations.some((c) => c.id === conversationId)) return false;
  return (
    assistant.userAccess?.mode === "own" ||
    conversations.some((c) => c.assistantId === assistant.id)
  );
}
