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
