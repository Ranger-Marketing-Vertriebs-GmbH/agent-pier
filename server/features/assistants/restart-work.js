import { decideAudited } from "./approval-audit.js";
import { stopSession } from "./coding-sessions/session-worktrees.js";

/**
 * The work a main-chat restart stops (design: main chat restart). The restart covers
 * the lead and its unarchived team members; runningWork previews what runs now and
 * stopWork stops the same items.
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

// The pending attempts of turns in `conversations`, routine runs and extra chats too.
function pendingTurns(service, conversations) {
  return service.ledger.pending().filter((attempt) => {
    try {
      const { conversationId } = service.ledger.getRequest(attempt.requestId);
      return conversations.has(conversationId);
    } catch {
      return false; // A request that went away meanwhile.
    }
  });
}

/**
 * What runs for the lead and the people in `scope`, item by item. The preview counts
 * it (runningWork) and the restart stops it (stopWork), so both always agree.
 */
function selectWork(service, leadId, scope) {
  const ids = new Set(scope.assistantIds);
  const conversations = new Set(
    service.store
      .listConversations()
      .filter((c) => ids.has(c.assistantId))
      .map((c) => c.id),
  );
  const teams = service.teams;
  const actions = service.workflows?.store;
  const mine = actions ? actions.list().filter((a) => ids.has(a.assistantId)) : [];
  return {
    turns: pendingTurns(service, conversations),
    teams: (teams?.store.list(leadId) || []).filter(
      (t) => t.phase === "awaiting_approval",
    ),
    members: scope.temporary.filter((m) => !ended.has(m.phase)),
    requests: (teams?.requests?.store.pending() || []).filter(
      (r) => r.parentAssistantId === leadId,
    ),
    runs: mine.filter(
      (a) => a.state === "running" && a.payload?.action === "coding_start",
    ),
    sessions: scope.assistantIds.flatMap((id) =>
      (service.workflows?.sessions?.store.forAgent(id) || []).filter((s) => !s.ended),
    ),
    goals: [...conversations].filter((id) => teams?.goals?.store.open(id)),
    approvals: mine.filter((a) => a.state === "awaiting_approval"),
    conversations,
  };
}

function summary(work) {
  return {
    turns: work.turns.length,
    teams: work.teams.length,
    members: work.members.length,
    requests: work.requests.length,
    coding: work.runs.length + work.sessions.length,
    goals: work.goals.length,
    approvals: work.approvals.length,
  };
}

/** What currently runs for the lead and the people in `restartScope`. */
export function runningWork(service, leadId) {
  return summary(selectWork(service, leadId, restartScope(service, leadId)));
}

/**
 * Stops what runs for the lead and the people in `scope` before its main chats
 * restart: proposals are declined, temporary members end, lead requests, approvals,
 * coding runs and sessions and work goals stop, and every pending turn is cancelled,
 * in extra chats too. Permanent members are never stopped here; only their turns are.
 * One failing step never skips the rest; the first error is thrown at the end.
 * Returns what it found running, counted as runningWork counts it.
 */
export async function stopWork(service, leadId, scope) {
  const work = selectWork(service, leadId, scope);
  let failure;
  const attempt = async (step) => {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  };
  const teams = service.teams;
  const w = service.workflows;
  for (const team of work.teams) await attempt(() => teams.stop(team.id));
  for (const member of work.members)
    await attempt(() => teams.stop(member.teamId, member.id));
  for (const request of work.requests)
    await attempt(() => teams.requests.stop(request.id, "owner"));
  for (const { id } of work.approvals)
    await attempt(() => {
      // Stopping a member may have withdrawn its request already.
      const a = w.store.get(id);
      if (a.state !== "awaiting_approval") return;
      decideAudited(
        service.audit,
        {
          origin: { kind: "owner", channel: "ui" },
          actionId: a.id,
          decision: "decline",
          revision: a.revision,
          kind: "action",
          assistantId: () => a.assistantId,
          attribution: () => a,
        },
        () =>
          w.store.patch(a.id, { state: "declined", diagnostic: "MAIN_CHAT_RESTARTED" }),
      );
    });
  for (const run of work.runs) await attempt(() => w.s.pipelines.cancel(run.runId));
  for (const { assistantId, sessionId } of work.sessions)
    await attempt(() =>
      stopSession(w, { assistantId }, { sessionId }).catch((error) => {
        // A session that is gone has nothing left to stop.
        if (error?.status !== 404) throw error;
      }),
    );
  for (const id of work.goals) await attempt(() => teams.goals.stop(id));
  // Read again: stopping members and requests above may have ended some turns.
  for (const turn of pendingTurns(service, work.conversations))
    await attempt(() => service.cancel(turn.id));
  if (work.approvals.length) service.changed({ feeds: false });
  if (failure) throw failure;
  return summary(work);
}
