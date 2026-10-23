import { assistantProblem } from "./assistant-validation.js";

// Member phases after which a task member's own team task is over.
export const memberEnded = new Set(["completed", "failed", "cancelled"]);

/**
 * Whether a lead can still reach its task member: its own, not archived and not kept
 * as permanent, and either working on its task or finished with a chat the lead can
 * still send questions and tasks to (lead-requests.js). Lead grants and lead edits
 * use the same rule.
 */
export function reachableMember(member, leadId) {
  return (
    !!member &&
    member.kind === "member" &&
    member.parentAssistantId === leadId &&
    member.lifetime !== "permanent" &&
    !member.archivedAt &&
    (!memberEnded.has(member.phase) || !!member.conversationId)
  );
}

/**
 * Whether a lead may edit a member of its own (member-edits.js): a task member it can
 * still reach, or a permanent member it kept, as long as that one is not archived.
 */
export function editableMember(member, leadId) {
  return (
    reachableMember(member, leadId) ||
    (!!member &&
      member.kind === "member" &&
      member.parentAssistantId === leadId &&
      member.lifetime === "permanent" &&
      !member.archivedAt)
  );
}

/**
 * The calling lead of a tool call and its own member it acts on (member edits and
 * summaries): members and archived agents never lead, and a member the lead cannot
 * edit (editableMember) is refused as ended. Synchronous.
 */
export function leadsMember(assistants, teams, inv, memberId) {
  if (typeof memberId !== "string") throw assistantProblem("invalid");
  inv.assertCurrent();
  const attempt = assistants.ledger.getAttempt(inv.attemptId),
    request = assistants.ledger.getRequest(attempt.requestId),
    conversation = assistants.store.getConversation(request.conversationId),
    lead = assistants.store.getAssistant(conversation.assistantId);
  if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
  let member;
  try {
    member = teams.member(memberId);
  } catch {
    throw assistantProblem("teamGrantMemberEnded", 409);
  }
  if (!editableMember(member, lead.id))
    throw assistantProblem("teamGrantMemberEnded", 409);
  return { conversation, lead, member };
}
