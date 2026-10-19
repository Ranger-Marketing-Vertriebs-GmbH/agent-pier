// What a lead's follow-up turn on a member's result (`member-result`) may change.
// The owner decided that such a turn acts like the lead's own work: it writes in the
// lead's own workspace and memory and in the project folders the owner granted the
// lead itself (never shares it received), while coding requests still wait for the
// owner. The member's text stays attributed data: it never proves an owner request,
// unlocks SSH, grants or other owner-only switches (agent-ssh-origin.js refuses it).
import { requestKind } from "./lead-request-store.js";

/**
 * The lead request a `member-result` turn hands over, when the turn is exactly its
 * follow-up (the ledger request AgentPier submitted for it) in a chat of the lead
 * that sent the request, and the lead is still active; null otherwise. Never throws.
 */
export function resultTurn(assistants, requestId, attemptId) {
  try {
    const teams = assistants.teams?.store;
    const r = typeof requestId === "string" ? teams?.find(requestId) : null;
    if (!r || r.kind !== requestKind) return null;
    const request = assistants.ledger.getRequest(
      assistants.ledger.getAttempt(attemptId).requestId,
    );
    const conversation = assistants.store.getConversation(request.conversationId);
    const lead = assistants.store.getAssistant(conversation.assistantId);
    if (
      request.clientRequestId !== `lead-request-result:${r.id}` ||
      conversation.assistantId !== r.parentAssistantId ||
      lead.archivedAt ||
      lead.teamMemberId
    )
      return null;
    return r;
  } catch {
    return null;
  }
}

/** One audit record per native write of a follow-up turn: the path, never content. */
export function auditResultWrite(assistants, r, input) {
  try {
    assistants.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: r.parentAssistantId,
      source: "system",
      outcome: "success",
      details: {
        kind: "native-write",
        tool: input.toolName,
        filePath: input.path,
        via: "member-result",
        leadRequestId: r.id,
      },
    });
  } catch (error) {
    console.error("Member result write audit failed:", error?.message);
  }
}
