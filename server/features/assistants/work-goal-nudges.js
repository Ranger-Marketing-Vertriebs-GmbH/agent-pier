// The nudge of work goals (AGENTPIER-208): once a chat with an open goal has been
// idle for `nudgeDelayMs`, AgentPier sends a continuation turn on the owner's behalf
// with the rights of the anchor, the owner's latest direct turn. It waits while the
// chat works or waits on the owner or on results, and brakes after repeated failed
// or idle turns. `idleSince`, the background holds, the tool runs and the
// continuations sent are in memory: a restart only restarts the delay, and a
// continuation this process did not send counts as progress.
import { teamActivePhases } from "./assistant-activity.js";
import { abortAndReview } from "./attempt-recovery.js";
import {
  continuationPrompt,
  directOwnerTurn,
  goalChat,
  recordedTurn,
} from "./goal-turns.js";
import { mainConversation } from "./routine-targets.js";
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

/**
 * Whether the session has background commands running, or a completion run of
 * OpenClaw 2026.10.7 under way (whose agent events carry no mark); any error says no.
 */
export async function backgroundRunning(service, sessionKey) {
  try {
    const answer = await service.assistants.runtime.client.call(backgroundMethod, {
      sessionKey,
    });
    return answer?.running > 0 || answer?.completing > 0;
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
    !!a.completionRuns?.live(conversation.runtimeSessionKey).length ||
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

// The chat a request's result will go to: the asking member's for a colleague's
// answer it takes itself, else the lead's main chat (peer-requests.js target).
function resultChat(goals, r) {
  if (!r.fromMemberId) return r.parentConversationId;
  return r.resultTo !== "lead" && goals.service.peers?.reachable(r)
    ? r.fromConversationId
    : mainConversation(goals.assistants.store, r.parentAssistantId)?.id;
}

// A question or task whose result will arrive in the chat: the lead's own, or a
// colleague's answer for a member. Member reports are not waited for.
function leadRequestOpen(goals, conversation) {
  return goals.service.requests.store
    .pending()
    .some(
      (r) =>
        r.type !== "report" &&
        !r.resultAttemptId &&
        !settledDeliveries.has(r.delivery) &&
        resultChat(goals, r) === conversation.id,
    );
}

/** The first hold in the chat itself that keeps it from a continuation, or null. */
export function goalWait(goals, conversation) {
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
  return null;
}

/**
 * Whether a background command in the chat's session holds the goal. Asked of the
 * Gateway only once the delay is over, or while a hold seen earlier lasts. The hold
 * lasts at most `backgroundWaitMs` from when the chat became idle around it.
 */
async function backgroundHold(goals, goal, conversation, since) {
  if (!(await backgroundRunning(goals.service, conversation.runtimeSessionKey))) {
    goals.backgroundSince.delete(goal.id);
    return false;
  }
  if (!goals.backgroundSince.has(goal.id)) goals.backgroundSince.set(goal.id, since);
  return goals.now() - goals.backgroundSince.get(goal.id) < backgroundWaitMs;
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
  // Only the owner's stop control is his; any other abort is AgentPier's or the Gateway's.
  if (attempt.state === "cancelled")
    return goals.end(goals.store.write(goal, evaluated), "stopped", {
      reasonCode: "turn-cancelled",
      source: goals.ownerCancelled(id) ? "user" : "system",
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

/**
 * An interrupted continuation AgentPier sent itself is reviewed as the owner's review
 * would (attempt-recovery.js): its run is aborted in its session, then the attempt is
 * marked reviewed, and it counts as a technical failure. An uncertain one may still
 * run and waits for the owner. A failed abort is tried again on the next pass.
 */
async function reviewInterrupted(goals, goal) {
  const a = goals.assistants;
  try {
    const attempt = goal.lastAttemptId && a.ledger.getAttempt(goal.lastAttemptId);
    if (attempt?.state !== "interrupted" || attempt.reviewedAt) return;
    const { clientRequestId } = a.ledger.getRequest(attempt.requestId);
    if (!clientRequestId.startsWith(`goal-continuation:${goal.id}:`)) return;
    // Settled meanwhile (the reconciler saw its end): it speaks for itself.
    if ((await abortAndReview(a, attempt)).reviewedAt)
      goals.audit(goal, "continuation-reviewed");
  } catch {
    /* Retried on the next pass; the attempt holds the chat until then. */
  }
}

async function nudge(goals, stale, anchor) {
  const a = goals.assistants,
    anchorContext = goals.teams.context(anchor.id);
  // The pass awaited the Gateway: a Stop or a new goal meanwhile wins.
  const goal = goals.store.open(stale.conversationId);
  if (goal?.id !== stale.id || goal.revision !== stale.revision) return goal;
  const clientRequestId = `goal-continuation:${goal.id}:${goal.nudges + 1}`;
  // Accepted before a crash that lost its bookkeeping: adopted as it was recorded.
  const lost = recordedTurn(goals.teams, goal.conversationId, clientRequestId);
  try {
    const { attempt } = await a.send(
      goal.conversationId,
      {
        clientRequestId,
        text: lost?.request.text ?? continuationPrompt(goal),
        ...((lost ? lost.teamAllowed : anchorContext.teamAllowed)
          ? { teamAllowed: true }
          : {}),
      },
      lost?.context ?? {
        kind: "owner",
        goal: { id: goal.id, anchorRequestId: anchor.id, title: goal.title },
      },
    );
    // A run another process sent was not watched for tool calls.
    if (!lost) goals.sent(attempt.id);
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
  await reviewInterrupted(goals, goal);
  goal = evaluate(goals, goal);
  if (goal.state !== "open") return;
  const hold = () => void goals.idleSince.delete(goal.id);
  if (goalWait(goals, conversation)) return hold();
  const since = goals.idleSince.get(goal.id) ?? goals.now();
  const due = goals.now() - since >= nudgeDelayMs;
  // The anchor is read only for a continuation about to go out.
  let anchor = null;
  if (due) {
    anchor = latestOwnerTurn(goals.service, goal.conversationId);
    if (!anchor) return goals.end(goal, "blocked", { reasonCode: "proof" });
    if (anchor.id !== goal.anchorRequestId)
      goal = goals.store.write(goal, { anchorRequestId: anchor.id });
  }
  // The Gateway is asked then too, and on every pass while a hold seen earlier lasts.
  if (
    (due || goals.backgroundSince.has(goal.id)) &&
    (await backgroundHold(goals, goal, conversation, since))
  )
    return hold();
  if (!due) return void goals.idleSince.set(goal.id, since);
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
