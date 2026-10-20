/**
 * Who decides an agent's approval: the person in whose chat it arose. A user's chat
 * (also a routine running in it) sends its approvals to her alone; everything else
 * goes to the owner. An action whose chat is gone stays the owner's.
 */
export function approvalAudience(action, store) {
  let conversation = null;
  try {
    if (action?.conversationId)
      conversation = store.getConversation(action.conversationId);
  } catch {
    conversation = null;
  }
  return typeof conversation?.userId === "string"
    ? { kind: "user", userId: conversation.userId }
    : { kind: "owner" };
}

/** Whether the action is the owner's to see and decide. */
export const ownerApproval = (action, store) =>
  approvalAudience(action, store).kind === "owner";
