// Which turn a runtime session's call belongs to (TeamBridge.bound, turn, agentOf):
// AgentPier's ledger and store, never anything the call itself claims.

export const activeStates = new Set(["pending", "accepted", "running"]);

/** The active attempts bound to a runtime session (`unresolved`: any unresolved one). */
export function boundAttempts(assistants, sessionKey, unresolved = false) {
  return assistants.ledger.pending().filter((a) => {
    const c = assistants.store.getConversation(
      assistants.ledger.getRequest(a.requestId).conversationId,
    );
    return (
      c.runtimeSessionKey === sessionKey && (unresolved || activeStates.has(a.state))
    );
  });
}

/** An attempt's request, chat agent and origin, and whether `agentId` runs it now. */
export function attemptTurn(assistants, teams, attempt, agentId) {
  const request = assistants.ledger.getRequest(attempt.requestId),
    parent = assistants.store.getAssistant(
      assistants.store.getConversation(request.conversationId).assistantId,
    ),
    origin = teams.store?.context(request.id);
  const current =
    !attempt.reviewedAt && parent.runtimeAgentId === agentId && !parent.archivedAt;
  return { attempt, parent, origin, current };
}

/** The agent with this runtime id, or null. */
export const agentByRuntimeId = (assistants, runtimeAgentId) =>
  assistants.store.listAssistants().find((a) => a.runtimeAgentId === runtimeAgentId) ||
  null;
