/**
 * Whether anyone can still review a chat's turn of unknown outcome (attempt-recovery.js).
 * A user's turn only she reviews, while she is active and the chat is still open to her
 * (UserScope): deleted, disabled or removed from its agent, she no longer can, and the
 * owner never decides her turns. The owner's turn only he reviews, while the agent is
 * not a user's own one, where he no longer chats.
 */
export function turnReviewable(services, conversation) {
  const store = services.assistants.store;
  if (typeof conversation.userId !== "string")
    return store.getAssistant(conversation.assistantId).userAccess?.mode !== "own";
  if (!services.users || !services.userScope) return true;
  try {
    if (services.users.get(conversation.userId).disabled) return false;
    const principal = { role: "user", userId: conversation.userId };
    services.userScope.conversationOf(principal, conversation.id);
    return true;
  } catch {
    return false;
  }
}
