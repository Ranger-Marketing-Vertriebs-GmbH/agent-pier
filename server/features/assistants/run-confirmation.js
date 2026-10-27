// A turn whose sessions.send acknowledgement was lost stays uncertain, and without
// proof it gets no new AgentPier tool calls (team-bridge.js, assistant-workflows.js);
// a call under way when the send timed out keeps running (boundTurnLive). The
// Gateway proves it runs the turn by an event of the turn's run (its run id is the
// attempt id, the send's idempotency key), by a project or share call of that run
// (its plugin names the tool call's run, TeamBridge.prepare) or by the turn's own
// user message in the transcript (delivery key `<attempt id>:user`,
// message-source.js). Any one moves
// the attempt to running on the Gateway generation the send went to
// (RequestLedger.confirm); nothing is sent again.

// The supervisor's per-launch id; the launch counter restarts with AgentPier.
const generationOf = (service) => service.runtime.generationId ?? null;

function confirm(service, attempt, proof) {
  const confirmed = service.ledger.confirm(attempt.id, {
    generation: generationOf(service),
    proof,
  });
  if (confirmed)
    service.changed({
      conversationId: service.ledger.getRequest(attempt.requestId).conversationId,
    });
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

/**
 * A bridge call of a session (TeamBridge.prepare) that names its tool call's run:
 * the Gateway's own hook reports the run, so a call of the turn's run proves it.
 */
export function confirmFromCall(service, sessionKey, runId) {
  const attempt = service.ledger.attemptForRun(runId);
  if (!attempt?.unconfirmed) return null;
  const request = service.ledger.getRequest(attempt.requestId);
  if (
    service.store.getConversation(request.conversationId).runtimeSessionKey !== sessionKey
  )
    return null;
  return confirm(service, attempt, "tool-call");
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

const liveStates = new Set(["pending", "accepted", "running"]);
/**
 * Whether a turn still serves a call already under way (TeamBridge.invoke started
 * it on a live turn): live and not reviewed, or only unconfirmed. A send whose
 * acknowledgement timed out while the call ran (a slow Gateway) proves no end of the
 * run, so a long call such as a coding session wait keeps going. Preparing or
 * starting a call still needs a live or proven turn; a plain uncertain turn (lost
 * connection, AgentPier restart) ends the call.
 */
export const boundTurnLive = (attempt) =>
  !!attempt &&
  !attempt.reviewedAt &&
  (liveStates.has(attempt.state) || attempt.unconfirmed === true);
