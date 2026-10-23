import { requestTerminal } from "./lead-request-store.js";

const ended = new Set(["completed", "failed", "cancelled"]);
// Follow-up delivery: retries back off and end after a few.
const delivery = { attempts: 5, baseMs: 2000, maxMs: 120000 };
const finalResult = new Set(["completed", "failed", "cancelled", "reviewed"]);

/**
 * Hands a finished request to its target as a follow-up turn, once that conversation
 * is idle. A lead's own cancel and an owner's decline need no follow-up.
 */
export async function deliverRequest(requests, id) {
  const a = requests.assistants;
  let r = requests.store.get(id);
  const settle = (patch) => requests.teams.write(r, { ...patch, settled: true });
  if (!ended.has(r.phase) || ["inline", "skipped", "failed"].includes(r.delivery)) {
    if (requestTerminal.has(r.phase) && r.delivery && !r.settled) settle({});
    return;
  }
  if (r.resultAttemptId) {
    const attempt = a.ledger.getAttempt(r.resultAttemptId);
    const state = attempt.reviewedAt ? "reviewed" : attempt.state;
    if (r.resultState !== state || (finalResult.has(state) && !r.settled))
      requests.teams.write(r, { resultState: state, settled: finalResult.has(state) });
    return;
  }
  if (r.phase === "cancelled" && r.cancelledBy === "lead")
    return settle({ delivery: "skipped" });
  if (a.store.getAssistant(r.parentAssistantId).archivedAt)
    return settle({ delivery: "skipped", resultDiagnostic: "PARENT_ARCHIVED" });
  // An ask still waiting takes the answer itself: a routine run has no attempt.
  if (Date.now() < (r.deliveryRetryAt || 0)) return;
  const target = requests.deliveryTarget(r);
  if (
    [...requests.waits.values()].includes(id) ||
    a.ledger
      .pending()
      .some(
        (x) => a.ledger.getRequest(x.requestId).conversationId === target.conversationId,
      )
  )
    return;
  if (r.delivery !== "pending") r = requests.teams.write(r, { delivery: "pending" });
  try {
    const sent = await a.send(
      target.conversationId,
      { clientRequestId: target.clientRequestId, text: target.text },
      target.context,
    );
    requests.teams.write(requests.store.get(id), {
      delivery: "sent",
      resultAttemptId: sent.attempt.id,
      resultState: sent.attempt.state,
    });
    a.changed();
  } catch (error) {
    // Busy or unavailable: retried with backoff; the stable client id adopts an
    // admitted follow-up. Anything else, or too many tries, ends visibly.
    const current = requests.store.get(id),
      failures = (current.deliveryFailures || 0) + 1;
    if (failures >= delivery.attempts || ![409, 503].includes(error?.status))
      requests.teams.write(current, {
        delivery: "failed",
        settled: true,
        resultDiagnostic: "FOLLOW_UP_FAILED",
        deliveryFailures: failures,
      });
    else
      requests.teams.write(current, {
        deliveryFailures: failures,
        deliveryRetryAt:
          Date.now() + Math.min(delivery.baseMs * 2 ** failures, delivery.maxMs),
      });
    a.changed();
  }
}
