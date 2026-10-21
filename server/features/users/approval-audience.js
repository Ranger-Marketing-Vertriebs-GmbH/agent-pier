/**
 * Who decides an agent's approval: the person in whose chat it arose. A user's chat
 * (also a routine running in it) sends its approvals to her alone; everything else
 * goes to the owner. A deleted chat keeps its person (storedConversation), so her
 * cards never become the owner's; an action whose chat record is gone stays his.
 */
export function approvalAudience(action, store) {
  let conversation = null;
  try {
    if (action?.conversationId)
      conversation = store.storedConversation(action.conversationId);
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

/**
 * The approvals waiting for a user that she can open and decide: hers, in a chat of
 * hers that is still open on an agent that still serves her (user-scope.js). The list
 * route and her event stream's count use the same set.
 */
export function awaitingForUser({ assistants, userScope }, principal) {
  return (assistants?.workflows?.store.awaiting(Date.now()) || []).filter((action) => {
    const audience = approvalAudience(action, assistants.store);
    if (audience.kind !== "user" || audience.userId !== principal.userId) return false;
    try {
      userScope.conversationOf(principal, action.conversationId);
      return true;
    } catch {
      return false;
    }
  });
}
