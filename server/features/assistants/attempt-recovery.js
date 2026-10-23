import { assistantProblem } from "./assistant-validation.js";

// Recovery after an attempt whose outcome is unknown: the owner acknowledges it, the
// owned runtime restarts, and the attempt is marked reviewed so a new one may follow.
export async function recoverAttempt(service, id, input) {
  if (input?.acknowledgeUnknownOutcome !== true) throw assistantProblem("invalid");
  const attempt = service.ledger.getAttempt(id);
  if (!["uncertain", "interrupted"].includes(attempt.state))
    throw assistantProblem("active", 409);
  if (
    service.ledger
      .pending()
      .some((a) => a.id !== id && !["uncertain", "interrupted"].includes(a.state))
  )
    throw assistantProblem("active", 409);
  if (service.recovering) throw assistantProblem("active", 409);
  service.recovering = true;
  try {
    // Confirm the owned process has exited before permitting another delivery.
    await service.runtime.stop({ urgent: true });
    await Promise.allSettled(
      [...service.locks.values(), service.reconciling].filter(Boolean),
    );
    const current = service.ledger.getAttempt(id);
    if (["uncertain", "interrupted"].includes(current.state)) service.ledger.review(id);
    await service.runtime.start();
    service.changed();
    return service.ledger.getAttempt(id);
  } finally {
    service.recovering = false;
  }
}

// A user's acknowledgement of her own uncertain or interrupted turn. Restarting the
// Gateway every agent shares stays with the owner, so a user never stops his or another
// user's runs in flight; her own run is aborted in her session instead (abortAndReview).
export async function acknowledgeAttempt(service, id, input) {
  if (input?.acknowledgeUnknownOutcome !== true) throw assistantProblem("invalid");
  const attempt = service.ledger.getAttempt(id);
  if (attempt.reviewedAt) return attempt;
  if (!unknownOutcome(attempt)) throw assistantProblem("active", 409);
  service.requireReady();
  return abortAndReview(service, attempt);
}

/**
 * A turn of unknown outcome that nobody can review any more (users/turn-review.js): its
 * user was deleted, disabled or removed from the agent, or it is the owner's on what is
 * now a user's own agent. Left pending, it would block runtime updates and the agent's
 * settings for good; reconciliation aborts its run and marks it reviewed. Never throws.
 */
export async function settleUnreviewable(service, attempt, conversation) {
  try {
    const current = service.ledger.getAttempt(attempt.id);
    if (current.reviewedAt || !unknownOutcome(current) || service.recovering) return;
    if (service.reviewable?.(conversation) !== false) return;
    await abortAndReview(service, current);
  } catch {
    /* Retried at the next reconciliation. */
  }
}

/**
 * Users' turns of unknown outcome, before the owner's maintenance (runtime updates,
 * provider changes, Gateway restarts, member recovery, account logout): only each
 * user reviews hers, in her app, and the owner neither sees her chat nor may decide
 * for her. Left pending, a turn she never comes back to would block his maintenance
 * for good, so it is settled as at her removal: its run is aborted in her session and
 * marked reviewed, and her chat shows its outcome as unknown. Never throws.
 */
export async function settleUserTurns(service) {
  if (!service.runtime.client?.ready || service.recovering) return;
  for (const attempt of service.ledger.unresolved()) {
    if (attempt.reviewedAt || !unknownOutcome(attempt)) continue;
    try {
      const { conversationId } = service.ledger.getRequest(attempt.requestId);
      if (typeof service.store.getConversation(conversationId).userId !== "string")
        continue;
      await abortAndReview(service, attempt);
    } catch {
      /* Still pending: the maintenance reports it as running work. */
    }
  }
}

const unknownOutcome = (attempt) => ["uncertain", "interrupted"].includes(attempt.state);

// Only once the Gateway took the abort of the run in its own session is the attempt
// marked reviewed and a new turn may follow: a send that timed out may still run there.
async function abortAndReview(service, attempt) {
  const conversation = service.store.getConversation(
    service.ledger.getRequest(attempt.requestId).conversationId,
  );
  try {
    await service.runtime.client.call("sessions.abort", {
      key: conversation.runtimeSessionKey,
      runId: attempt.runtimeRunId || attempt.id,
    });
  } catch {
    throw assistantProblem("active", 409);
  }
  // Confirmed or ended meanwhile: the run speaks for itself.
  const current = service.ledger.getAttempt(attempt.id);
  if (current.reviewedAt || !unknownOutcome(current)) return current;
  const reviewed = service.ledger.review(attempt.id);
  service.changed({ conversationId: conversation.id });
  return reviewed;
}
