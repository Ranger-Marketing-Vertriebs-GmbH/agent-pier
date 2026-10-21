// Ends a chat turn that hangs without a sign of life (AGENTPIER-184). OpenClaw
// 2026.10.3 aborts a model stream that stays quiet (120 s for cloud models, retried a
// few times, each retry an event), but a run stuck elsewhere, before its model call
// (preparing a long context) or in a provider that never answers, only ends at the
// agent run budget (`agents.defaults.timeoutSeconds`, 48 h unless the owner set one).
// A run AgentPier observed that sends no event for `stallAbortMs` while it waits for
// the model is aborted in its session and its turn fails with the reason "stalled".
// A running tool, an exec approval and a compaction are not stalled: they report
// nothing until they end and have their own timeouts.

/** How long a run may stay silent while it waits for the model. */
export const stallAbortMs = 15 * 60 * 1000;
const waiting = new Set(["model", "thinking", "writing", "retrying"]);

/** One pass; runs during the service's poll. Never throws. */
export async function guardStalledRuns(service) {
  if (service.stallGuarding || !service.runtime.client?.ready || service.closed) return;
  service.stallGuarding = true;
  try {
    for (const [runId] of service.runSteps.list()) {
      if (service.closed || !service.runtime.client?.ready) return;
      if (!stalled(service, runId)) continue;
      await endStalled(service, runId).catch((error) =>
        console.error(`Stalled agent turn of run ${runId} not ended:`, error?.message),
      );
    }
  } finally {
    service.stallGuarding = false;
  }
}

// Read now, not from the pass's start: an earlier abort may have taken a while. A run
// not heard from since the Gateway reconnected may have ended unseen (run-steps.js).
function stalled(service, runId) {
  const run = service.runSteps.state(runId);
  return Boolean(run?.live && waiting.has(run.phase) && run.quietMs >= stallAbortMs);
}

async function endStalled(service, runId) {
  const { sessionKey } = service.runSteps.state(runId);
  const conversation = service.store.conversationOfSession(sessionKey);
  const attempt = conversation && activeAttempt(service, conversation.id, runId);
  // Not a turn of an open chat (or already over): forget it, nothing to end.
  if (!attempt) return service.runSteps.end(runId);
  // Marked before the abort: the reconciler may see the aborted run first and then
  // records it as stalled, not cancelled (run-reconciler.js). A reply that ends the
  // run meanwhile takes the mark away (gateway-wiring.js).
  const failures = (service.runFailures ??= new Map());
  failures.set(runId, "stalled");
  if (failures.size > 64) failures.delete(failures.keys().next().value);
  try {
    await service.runtime.client.call("sessions.abort", { key: sessionKey, runId });
  } catch (error) {
    if (failures.get(runId) === "stalled") failures.delete(runId);
    throw error;
  }
  console.warn(`Agent turn ${attempt.id} aborted: no sign of life while it waited.`);
  const current = service.ledger.getAttempt(attempt.id);
  // Ended meanwhile (its reply arrived, or the reconciler settled it): it speaks for
  // itself.
  if (
    failures.get(runId) === "stalled" &&
    ["accepted", "running"].includes(current.state)
  )
    service.ledger.transition(attempt.id, "failed", {
      runtimeRunId: current.runtimeRunId || runId,
      failure: "stalled",
    });
  service.runSteps.end(runId);
  service.feeds?.endRun(conversation.id, runId);
  service.changed({ conversationId: conversation.id });
}
function activeAttempt(service, conversationId, runId) {
  return service.ledger
    .unresolved()
    .find(
      (a) =>
        ["accepted", "running"].includes(a.state) &&
        (a.runtimeRunId === runId || a.id === runId) &&
        service.ledger.getRequest(a.requestId).conversationId === conversationId,
    );
}
