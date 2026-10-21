import { settleUnreviewable } from "./attempt-recovery.js";

export function terminalState(result) {
  if (result.status === "ok")
    return result.stopReason === "rpc" || result.aborted ? "cancelled" : "completed";
  if (result.status === "error") return "failed";
  if (result.status === "aborted") return "cancelled";
  return null;
}
// OpenClaw 2026.10.3 ends a run whose model stayed silent with a `chat` error of
// `errorKind: "timeout"`; `agent.wait` then reports only the error text.
function timedOut(service, runId, result) {
  return (
    service.runFailures?.get(runId) === "timeout" ||
    typeof result.timeoutPhase === "string"
  );
}
export async function reconcileRuns(service) {
  if (!service.runtime.client?.ready || service.closed) return;
  for (const attempt of service.ledger.unresolved()) {
    if (service.closed) return;
    // Its send decides first (conversation-turns.js).
    if (service.sending?.has(attempt.id)) continue;
    const request = service.ledger.getRequest(attempt.requestId);
    const conversation = service.store.getConversation(request.conversationId);
    try {
      // The pinned sessions.send contract uses the idempotency key as run identity.
      // Querying it is safe after a lost acknowledgement; sending it again is not.
      const result = await service.runtime.client.call(
        "agent.wait",
        { runId: attempt.runtimeRunId || attempt.id, timeoutMs: 1 },
        { timeoutMs: 3000 },
      );
      const runId = result.runId || attempt.runtimeRunId;
      // A run the stall guard aborted fails as stalled, not cancelled (run-stall-guard.js).
      const stalled =
        service.runFailures?.get(runId || attempt.id) === "stalled" &&
        terminalState(result) === "cancelled";
      const state = stalled ? "failed" : terminalState(result);
      if (state)
        service.ledger.transition(attempt.id, state, {
          runtimeRunId: runId,
          // A model that never answered in time (gateway-wiring.js runFailures).
          ...(stalled
            ? { failure: "stalled" }
            : state === "failed" && timedOut(service, runId || attempt.id, result)
              ? { failure: "timeout" }
              : {}),
        });
      else {
        const described = await service.runtime.client.call("sessions.describe", {
          key: conversation.runtimeSessionKey,
        });
        if (described.session?.subagentRunState === "interrupted")
          service.ledger.transition(attempt.id, "interrupted", {});
        else if (attempt.state === "pending")
          service.ledger.transition(attempt.id, "uncertain", {});
      }
      await service.history(conversation.id);
    } catch {
      /* Unavailable evidence cannot prove an execution outcome. */
    }
    await settleUnreviewable(service, attempt, conversation);
  }
}
