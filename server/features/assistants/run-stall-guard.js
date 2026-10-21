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
    for (const [runId, sessionKey, phase, quietMs] of service.runSteps.list()) {
      if (!waiting.has(phase) || quietMs < stallAbortMs) continue;
      await endStalled(service, runId, sessionKey).catch(() => {});
    }
  } finally {
    service.stallGuarding = false;
  }
}

async function endStalled(service, runId, sessionKey) {
  const conversation = service.store.conversationOfSession(sessionKey);
  const attempt = conversation && activeAttempt(service, conversation.id, runId);
  // Not a turn of an open chat (or already over): forget it, nothing to end.
  if (!attempt) return service.runSteps.end(runId);
  await service.runtime.client.call("sessions.abort", { key: sessionKey, runId });
  service.ledger.transition(attempt.id, "failed", {
    runtimeRunId: attempt.runtimeRunId || runId,
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
