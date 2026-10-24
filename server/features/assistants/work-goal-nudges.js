// The nudge of work goals (AGENTPIER-208): once a chat with an open goal has been
// idle for `nudgeDelayMs`, AgentPier sends a continuation turn on the owner's behalf
// with the rights of the anchor, the owner's latest direct turn. It waits while the
// chat works or waits on the owner or on results, and brakes after repeated failed
// or idle turns. `idleSince`, the background holds, the tool runs and the
// continuations sent are in memory: a restart only restarts the delay, and a
// continuation this process did not send counts as progress.
import { teamActivePhases } from "./assistant-activity.js";
import { continuationPrompt, directOwnerTurn, goalChat } from "./goal-turns.js";
import { backgroundMethod } from "./team-plugin/background-commands.js";

export const nudgeDelayMs = 90000;
export const technicalFailureLimit = 3;
export const idleTurnLimit = 3;
export const backgroundWaitMs = 7200000;

const settledDeliveries = new Set(["inline", "skipped", "failed"]);
const terminalAttempts = new Set(["completed", "failed", "cancelled"]);
const technicalAttempts = new Set(["failed", "interrupted", "uncertain"]);
// A refusal that only says "not now": the delay starts over.
const notNow = new Set([409, 503]);

/** The chat's newest request whose turn is the owner's own, or null. */
export function latestOwnerTurn(service, conversationId) {
  const requests = service.store.ledger.requests(conversationId);
  for (let n = requests.length - 1; n >= 0; n--)
    if (directOwnerTurn(service.store.context(requests[n].id))) return requests[n];
  return null;
}

/** Whether the session has background commands running; any error says no. */
export async function backgroundRunning(service, sessionKey) {
  try {
    const answer = await service.assistants.runtime.client.call(backgroundMethod, {
      sessionKey,
    });
    return answer?.running > 0;
  } catch {
    return false;
  }
}

function busy(a, conversation) {
  const id = conversation.id;
  return (
    a.ledger
      .pending()
      .some((attempt) => a.ledger.getRequest(attempt.requestId).conversationId === id) ||
    !!a.heartbeatRuns?.live(conversation.runtimeSessionKey).length ||
    !!a.longChats?.compacting(id) ||
    ["waiting", "sending"].includes(a.queued?.get(id)?.state)
  );
}

function awaitingApproval(goals, conversation) {
  const id = conversation.id,
    agentId = conversation.assistantId;
  const actions = goals.assistants.workflows?.store.list(agentId) ?? [];
  return (
    actions.some(
      (a) =>
        a.conversationId === id &&
        (a.state === "awaiting_approval" ||
          (a.followUp && !a.followUpSent && !a.settled)),
    ) ||
    goals.teams
      .list(agentId)
      .some((t) => t.parentConversationId === id && t.phase === "awaiting_approval")
  );
}

function leadRequestOpen(goals, conversation) {
  return goals.service.requests.store
    .pending()
    .some(
      (r) =>
        r.parentConversationId === conversation.id &&
        !r.fromMemberId &&
        r.type !== "report" &&
        !r.resultAttemptId &&
        !settledDeliveries.has(r.delivery),
    );
}

/** The first hold that keeps the goal's chat from a continuation now, or null. */
export async function goalWait(goals, goal, conversation) {
  if (busy(goals.assistants, conversation)) return "busy";
  if (awaitingApproval(goals, conversation)) return "approval";
  if (leadRequestOpen(goals, conversation)) return "lead-request";
  if (
    goals.teams
      .list(conversation.assistantId)
      .some(
        (t) =>
          t.parentConversationId === conversation.id && teamActivePhases.has(t.phase),
      )
  )
    return "team";
  if (await backgroundRunning(goals.service, conversation.runtimeSessionKey)) {
    // The hold lasts at most `backgroundWaitMs` from when it was first seen.
    if (!goals.backgroundSince.has(goal.id))
      goals.backgroundSince.set(goal.id, goals.now());
    if (goals.now() - goals.backgroundSince.get(goal.id) < backgroundWaitMs)
      return "background";
  } else goals.backgroundSince.delete(goal.id);
  return null;
}

// A failed turn or send counts towards the technical brake.
function technicalFailure(goals, goal, patch = {}) {
  const failures = goal.failures + 1;
  const next = goals.store.write(goal, { ...patch, failures });
  return failures >= technicalFailureLimit
    ? goals.end(next, "blocked", { reasonCode: "technical" })
    : next;
}

/** Counts the outcome of the goal's last continuation, once it is known. */
export function evaluate(goals, goal) {
  const id = goal.lastAttemptId;
  if (!id || goal.evaluatedAttemptId === id) return goal;
  let attempt;
  try {
    attempt = goals.teams.ledger.getAttempt(id);
  } catch {
    return goals.store.write(goal, { evaluatedAttemptId: id });
  }
  if (!terminalAttempts.has(attempt.state) && !attempt.reviewedAt) return goal;
  const evaluated = { evaluatedAttemptId: id };
  if (attempt.state === "cancelled")
    return goals.end(goals.store.write(goal, evaluated), "stopped", {
      reasonCode: "turn-cancelled",
      source: "user",
    });
  if (technicalAttempts.has(attempt.state))
    return technicalFailure(goals, goal, evaluated);
  // Only a run this process sent was watched for tool calls; any other counts.
  const progress =
    !goals.sentRun(id) || goals.toolRun(id) || goals.toolRun(attempt.runtimeRunId);
  const idleTurns = progress ? 0 : goal.idleTurns + 1;
  const next = goals.store.write(goal, { ...evaluated, failures: 0, idleTurns });
  return idleTurns >= idleTurnLimit
    ? goals.end(next, "blocked", { reasonCode: "no-progress" })
    : next;
}

async function nudge(goals, stale, anchor) {
  const a = goals.assistants,
    anchorContext = goals.teams.context(anchor.id);
  // The pass awaited the Gateway: a Stop or a new goal meanwhile wins.
  const goal = goals.store.open(stale.conversationId);
  if (goal?.id !== stale.id || goal.revision !== stale.revision) return goal;
  try {
    const { attempt } = await a.send(
      goal.conversationId,
      {
        clientRequestId: `goal-continuation:${goal.id}:${goal.nudges + 1}`,
        text: continuationPrompt(goal),
        ...(anchorContext.teamAllowed ? { teamAllowed: true } : {}),
      },
      {
        kind: "owner",
        goal: { id: goal.id, anchorRequestId: anchor.id, title: goal.title },
      },
    );
    goals.sent(attempt.id);
    const next = goals.store.write(goal, {
      nudges: goal.nudges + 1,
      lastAttemptId: attempt.id,
    });
    goals.audit(next, "continued");
    return next;
  } catch (error) {
    if (notNow.has(error?.status)) return goal;
    return technicalFailure(goals, goal);
  }
}

async function tickGoal(goals, goal) {
  const a = goals.assistants;
  let conversation, agent;
  try {
    conversation = a.store.getConversation(goal.conversationId);
    agent = a.store.getAssistant(conversation.assistantId);
  } catch {
    return goals.forget(goal.conversationId);
  }
  if (conversation.archivedAt || agent.archivedAt)
    return goals.end(goal, "ended", { reasonCode: "archived" });
  if (!goalChat(agent, conversation))
    return goals.end(goal, "ended", { reasonCode: "ineligible" });
  goal = evaluate(goals, goal);
  if (goal.state !== "open") return;
  const anchor = latestOwnerTurn(goals.service, goal.conversationId);
  if (!anchor) return goals.end(goal, "blocked", { reasonCode: "proof" });
  if (anchor.id !== goal.anchorRequestId)
    goal = goals.store.write(goal, { anchorRequestId: anchor.id });
  if (await goalWait(goals, goal, conversation))
    return void goals.idleSince.delete(goal.id);
  if (!goals.idleSince.has(goal.id)) goals.idleSince.set(goal.id, goals.now());
  if (goals.now() - goals.idleSince.get(goal.id) < nudgeDelayMs) return;
  // The next delay starts once the continuation has ended (or was refused).
  goals.idleSince.delete(goal.id);
  await nudge(goals, goal, anchor);
}

function tickable(goals) {
  const a = goals.assistants;
  return (
    !goals.closed &&
    !a.closed &&
    !a.maintenance &&
    !a.recovering &&
    !!a.runtime?.client?.ready
  );
}

/** One pass over the open goals; a pass under way is joined, never doubled. */
export function tickGoals(goals) {
  if (goals.ticking) return goals.ticking;
  if (!tickable(goals)) return Promise.resolve();
  goals.ticking = (async () => {
    for (const goal of goals.store.openGoals()) {
      if (!tickable(goals)) return;
      try {
        await tickGoal(goals, goal);
      } catch (error) {
        console.error("Work goal pass failed:", error?.message);
      }
    }
  })().finally(() => {
    goals.ticking = null;
  });
  return goals.ticking;
}
