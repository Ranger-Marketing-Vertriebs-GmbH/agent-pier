// After a Gateway (re)start the agents run without write and edit until the team
// plugin reports its write guard (WRITE_GUARD_PENDING, team-bridge.js). An owner
// turn admitted in that window would silently lose what it was asked to remember,
// so it waits, outside the admission lock, for at most one report interval
// (team-plugin/tool-guard.js guardReportMs) plus a margin.
export const writeGuardWaitMs = 16000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownTurn = (context) =>
  ["owner", "telegram"].includes(context?.kind) && !context.forwarded;

/** True when the turn may run with writes; false when the guard is still pending. */
export async function awaitWriteGuard(service, conversationId, input, context) {
  if (!ownTurn(context) || !service.config.writeGuardPending) return true;
  // A retry returns the accepted request and sends nothing.
  if (
    service.ledger
      .requests(conversationId)
      .some((r) => r.clientRequestId === input?.clientRequestId)
  )
    return true;
  const assistant = service.store.getAssistant(
    service.store.getConversation(conversationId).assistantId,
  );
  const until = Date.now() + (service.writeGuardWaitMs ?? writeGuardWaitMs);
  while (service.config.writeGuardPending(assistant)) {
    if (Date.now() >= until || service.closed) return false;
    await pause(100);
  }
  return true;
}

/**
 * A turn sent without writes gets a chat note; its AGENTS.md already tells the
 * agent that memory is read-only (assistant-bootstrap.js). Retries of an
 * accepted request add nothing.
 */
export function noteReadOnlyTurn(service, conversationId, result) {
  if (!result?.request) return;
  const added = service.memoryNotes.record({
    key: `guard-pending:${result.request.id}`,
    conversationId,
    reason: "guard-pending",
  });
  if (added) service.changed();
}
