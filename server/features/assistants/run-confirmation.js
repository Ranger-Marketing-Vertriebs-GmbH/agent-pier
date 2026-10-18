// A turn whose sessions.send acknowledgement was lost stays uncertain, and without
// proof it gets no AgentPier tools (team-bridge.js, assistant-workflows.js). The
// Gateway proves it runs the turn by an event of the turn's run (its run id is the
// attempt id, the send's idempotency key) or by the turn's own user message in the
// transcript (delivery key `<attempt id>:user`, message-source.js). Either one moves
// the attempt to running on the Gateway generation the send went to
// (RequestLedger.confirm); nothing is sent again.

const generationOf = (service) => service.runtime.generation ?? null;

function confirm(service, attempt, proof) {
  const confirmed = service.ledger.confirm(attempt.id, {
    generation: generationOf(service),
    proof,
  });
  if (confirmed) service.changed();
  return confirmed;
}

/** A Gateway event (chat or agent) of a known conversation's session. */
export function confirmFromEvent(service, conversation, payload) {
  const attempt = service.ledger.attemptForRun(payload?.runId);
  if (!attempt?.unconfirmed) return null;
  if (service.ledger.getRequest(attempt.requestId).conversationId !== conversation.id)
    return null;
  return confirm(service, attempt, "event");
}

/** The public messages of a conversation's current history page. */
export function confirmFromTranscript(service, conversationId, messages) {
  const keys = new Set(
    messages.filter((m) => m.role === "user" && m.turnKey).map((m) => m.turnKey),
  );
  if (!keys.size) return;
  for (const attempt of service.ledger.unresolved()) {
    if (!attempt.unconfirmed || !keys.has(attempt.id)) continue;
    if (service.ledger.getRequest(attempt.requestId).conversationId === conversationId)
      confirm(service, attempt, "transcript");
  }
}
