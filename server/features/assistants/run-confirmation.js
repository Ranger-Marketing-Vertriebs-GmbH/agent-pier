// A turn whose sessions.send acknowledgement was lost stays uncertain, and without
// proof it gets no new AgentPier tool calls (team-bridge.js, workspace-calls.js): they
// are refused as TURN_UNCONFIRMED, which the agent may retry after a short wait; a
// call under way when the send timed out keeps running (boundTurnLive). The Gateway
// proves it runs the turn by the late acknowledgement itself (GatewayClient onLate,
// conversation-turns.js), by an event of the turn's run (its run id is the attempt
// id, the send's idempotency key), by any AgentPier tool call or native write of
// that run (the plugin names its run: TeamBridge.prepare, invoke, toolPolicy) or the
// turn's own user message in the transcript (delivery key `<attempt id>:user`,
// message-source.js). Any one moves the attempt to running on the Gateway
// generation the send went to (RequestLedger.confirm); nothing is sent again.
//
// None of them grants a right: a proof only moves the one attempt it names from
// "uncertain, send unacknowledged" to running, the state a timely acknowledgement
// would have left, and only while that attempt is unreviewed, belongs to the calling
// session and was sent to the current Gateway. Every other check of a call (agent,
// session, origin, grants, shares) runs as for any running turn.
import { assistantProblem } from "./assistant-validation.js";

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

/**
 * The Gateway's own acknowledgement of the turn's sessions.send, arriving after the
 * client's timeout: it answers AgentPier's request over the authenticated
 * connection, so it proves the run as an event of it would.
 */
export function confirmFromAck(service, attemptId) {
  const attempt = service.ledger.attemptForRun(attemptId);
  if (attempt?.id !== attemptId || !attempt.unconfirmed) return null;
  return confirm(service, attempt, "ack");
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

/**
 * The refusal of a new call on a turn whose start is not proven yet: TURN_UNCONFIRMED
 * (retry after a short wait) while its send is only unacknowledged, FORBIDDEN for
 * every other turn that is not live.
 */
export const turnRefusal = (attempt) =>
  attempt?.unconfirmed === true && !attempt.reviewedAt
    ? assistantProblem("turnUnconfirmed", 409)
    : assistantProblem("invalid", 403);

/**
 * The live attempt a call of an AgentPier tool works for, re-read when the call
 * starts its work (after waiting for the admission lock, which a send holds until
 * it is acknowledged or times out). A call naming its run (`inv.runId`) proves an
 * unacknowledged send of its own session first; otherwise throws turnRefusal.
 */
export function liveAttempt(service, inv) {
  if (inv.runId) confirmFromCall(service, inv.sessionKey, inv.runId);
  const attempt = service.ledger.getAttempt(inv.attemptId);
  if (!liveStates.has(attempt.state) || attempt.reviewedAt) throw turnRefusal(attempt);
  return attempt;
}
