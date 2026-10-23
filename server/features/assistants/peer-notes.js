import { requestTerminal } from "./lead-request-store.js";

/**
 * Quiet lines in a lead's main chat for its members' requests to each other: one when
 * a request starts, one once it ends. They name only who asked whom and how it ended,
 * never the text or the answer, and are no lead turn. A request retention dropped
 * (LeadRequestStore.prune) takes its notes with it.
 */
export function peerNotes(service, conversationId) {
  const requests = service.teams?.requests?.store;
  if (!requests) return [];
  const { assistantId } = service.store.getConversation(conversationId);
  return requests.list(assistantId).flatMap((r) => {
    if (!r.fromMemberId || r.parentConversationId !== conversationId) return [];
    const note = (id, phase, at) => ({
      id,
      role: "event",
      event: "peer-request",
      phase,
      type: r.type,
      from: r.fromName,
      to: r.memberName,
      timestamp: at,
      runId: null,
    });
    const start = note(`peer-start:${r.id}`, "started", Date.parse(r.createdAt));
    const end = Date.parse(r.finishedAt);
    return requestTerminal.has(r.phase) && Number.isFinite(end)
      ? [start, note(`peer-end:${r.id}`, r.phase, end)]
      : [start];
  });
}
