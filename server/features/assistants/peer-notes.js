import { requestTerminal } from "./lead-request-store.js";
import { mainConversation } from "./routine-targets.js";

/**
 * Quiet lines in a lead's main chat for its members' requests to each other: one when
 * a request starts, one once it ends. They name only who asked whom and how it ended,
 * never the text or the answer, and are no lead turn. A request retention dropped
 * (LeadRequestStore.prune) takes its notes with it. A request made while the lead had
 * no main chat (no stored chat) shows in whichever main chat the lead has now.
 */
export function peerNotes(service, conversationId) {
  const requests = service.teams?.requests?.store;
  if (!requests) return [];
  const { assistantId } = service.store.getConversation(conversationId);
  if (mainConversation(service.store, assistantId)?.id !== conversationId) return [];
  return requests.list(assistantId).flatMap((r) => {
    if (!r.fromMemberId) return [];
    if (r.parentConversationId && r.parentConversationId !== conversationId) return [];
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
