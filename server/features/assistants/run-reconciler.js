export function terminalState(result) {
  if (result.status === "ok")
    return result.stopReason === "rpc" || result.aborted ? "cancelled" : "completed";
  if (result.status === "error") return "failed";
  if (result.status === "aborted") return "cancelled";
  return null;
}
export async function reconcileRuns(service) {
  if (!service.runtime.client?.ready || service.closed) return;
  for (const attempt of service.ledger.unresolved()) {
    if (service.closed) return;
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
      const state = terminalState(result);
      if (state)
        service.ledger.transition(attempt.id, state, {
          runtimeRunId: result.runId || attempt.runtimeRunId,
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
  }
}
