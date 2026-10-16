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
    await service.runtime.stop();
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
