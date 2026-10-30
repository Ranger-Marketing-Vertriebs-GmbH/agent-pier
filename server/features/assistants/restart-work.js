/**
 * The work a main-chat restart would stop (design: main chat restart). The restart
 * covers the lead and its unarchived team members; the counts below only preview what
 * is running now, they never stop anything.
 */

const ended = new Set(["completed", "failed", "cancelled", "declined"]);

/**
 * The lead, its permanent members and its temporary members that are not archived.
 * `assistantIds` holds the assistant ids of all three, the lead first.
 */
export function restartScope(service, leadId) {
  const members = (service.teams?.store.members() || []).filter(
    (m) => m.parentAssistantId === leadId && !m.archivedAt,
  );
  const permanent = members.filter((m) => m.lifetime === "permanent");
  const temporary = members.filter((m) => m.lifetime === "task");
  return {
    assistantIds: [
      leadId,
      ...[...permanent, ...temporary].map((m) => m.assistantId).filter(Boolean),
    ],
    permanent,
    temporary,
  };
}

function turnCount(service, conversations) {
  let turns = 0;
  for (const attempt of service.ledger.pending()) {
    try {
      const { conversationId } = service.ledger.getRequest(attempt.requestId);
      if (conversations.has(conversationId)) turns += 1;
    } catch {
      /* A request that went away meanwhile. */
    }
  }
  return turns;
}

/** What currently runs for the lead and the people in `restartScope`. */
export function runningWork(service, leadId) {
  const { assistantIds, temporary } = restartScope(service, leadId);
  const ids = new Set(assistantIds);
  const conversations = new Set(
    service.store
      .listConversations()
      .filter((c) => ids.has(c.assistantId))
      .map((c) => c.id),
  );
  const teams = service.teams;
  const actions = service.workflows?.store;
  const mine = actions ? actions.list().filter((a) => ids.has(a.assistantId)) : [];
  const sessions = assistantIds.flatMap(
    (id) => service.workflows?.sessions?.store.forAgent(id) || [],
  );
  return {
    turns: turnCount(service, conversations),
    teams: (teams?.store.list(leadId) || []).filter(
      (t) => t.phase === "awaiting_approval",
    ).length,
    members: temporary.filter((m) => !ended.has(m.phase)).length,
    requests: (teams?.requests?.store.pending() || []).filter(
      (r) => r.parentAssistantId === leadId,
    ).length,
    coding:
      mine.filter((a) => a.state === "running" && a.payload?.action === "coding_start")
        .length + sessions.filter((s) => !s.ended).length,
    goals: [...conversations].filter((id) => teams?.goals?.store.open(id)).length,
    approvals: mine.filter((a) => a.state === "awaiting_approval").length,
  };
}
