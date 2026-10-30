import { setTimeout as delay } from "node:timers/promises";
import { abortAndReview } from "./attempt-recovery.js";

// "Pause agents and update" (docs/assistant-runtime-updates.md#pause-agents-and-update):
// inside maintenance, where nothing new starts, AgentPier resolves exactly the blocker
// items the owner confirmed, each through the path the owner would take by hand, and
// audits each with `via: "runtime-update"`. Nothing is ever sent again: Telegram
// entries are closed, unknown outcomes reviewed. A sign-in in progress is never
// cancelled, and an item that is new or changed since the dialog opened (another
// revision) means nothing is touched at all.

const unknownOutcome = new Set(["uncertain", "interrupted"]);
const waitStepMs = 500;

/**
 * Whether every current item was confirmed with its current revision and none of them
 * is a sign-in (resolution "none"). Only then does the forced update touch anything.
 */
export function confirmedAll(items, confirmed) {
  const revisions = new Map((confirmed || []).map((entry) => [entry.id, entry.revision]));
  return items.every(
    (i) => i.resolution !== "none" && revisions.get(i.id) === i.revision,
  );
}

function audit(s, item, verb, result, outcome = "success") {
  try {
    s.audit?.append({
      action: `assistant.${verb}`,
      resourceType: "assistant",
      ...(item.agent?.id ? { resourceId: item.agent.id } : {}),
      source: "user",
      outcome,
      details: {
        kind: "runtime-update",
        via: "runtime-update",
        item: item.kind,
        result,
        ...(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(item.ref.id)
          ? { entryId: item.ref.id }
          : {}),
      },
    });
  } catch (error) {
    console.error("Runtime update resolution audit failed:", error?.message);
  }
}

// A running turn is stopped through the Gateway like the owner's stop control
// (AssistantService.cancel); reconciliation does not run in maintenance, so the
// attempt is recorded as cancelled once the Gateway took the abort. An unknown
// outcome is reviewed the way a user's own review is: aborted, then marked reviewed.
async function chatTurn(s, item) {
  const a = s.assistants;
  const attempt = a.ledger.getAttempt(item.ref.id);
  if (attempt.reviewedAt || ["completed", "failed", "cancelled"].includes(attempt.state))
    return;
  if (unknownOutcome.has(attempt.state)) {
    await abortAndReview(a, attempt);
    return audit(s, item, "updated", "reviewed");
  }
  const chat = a.store.getConversation(
    a.ledger.getRequest(attempt.requestId).conversationId,
  );
  await a.runtime.client.call("sessions.abort", {
    key: chat.runtimeSessionKey,
    runId: attempt.runtimeRunId || attempt.id,
  });
  a.ledger.transition(
    attempt.id,
    "cancelled",
    { runtimeRunId: attempt.runtimeRunId, cancelledBy: "runtime-update" },
    { from: attempt.state },
  );
  a.changed?.({ conversationId: chat.id });
  audit(s, item, "cancelled", "cancelled");
}

// The owner's team stop (TeamService.stop): pending member requests are withdrawn,
// queued members cancelled and running ones aborted.
async function teamStop(s, item) {
  await s.assistantTeams.stop(item.ref.id);
  audit(s, item, "cancelled", "cancelled");
}
// Once the members' turns ended, the members and their team record their end; the
// team's report goes to its lead after the update, as after any stop.
async function teamSettle(s, item) {
  const scheduler = s.assistantTeams.scheduler;
  for (const id of item.ref.members) await scheduler.observe?.(id);
  await scheduler.results?.collect(item.ref.id);
}

async function channelEntry(s, item) {
  const c = s.assistantChannels;
  const closed =
    item.kind === "channel_input"
      ? await c.closeForUpdate(item.ref.channelId, item.ref.id)
      : await c.closeNoticeForUpdate(item.ref.channelId, item.ref.id);
  if (closed) audit(s, item, "updated", "closed");
}

// Agent actions (assistant-workflows.js): one approved but not started is cancelled,
// a coding run through its pipeline's own cancel, an unknown outcome reviewed as the
// owner's "review" decision does. Admission is closed in maintenance, so the store is
// written directly; the action's follow-ups run once the update has finished.
async function workflow(s, item) {
  const w = s.assistants.workflows;
  const action = w.store.get(item.ref.id);
  if (action.state === "approved") {
    w.store.patch(action.id, { state: "cancelled" });
    audit(s, item, "cancelled", "cancelled");
  } else if (action.state === "unknown") {
    w.store.patch(action.id, { state: "reviewed" });
    audit(s, item, "updated", "reviewed");
  } else if (item.resolution === "cancel" && action.state === "running") {
    await s.pipelines.cancel(action.runId);
    let run = action.run;
    try {
      run = s.mcpTools?.summary(s.pipelines.get(action.runId)) ?? run;
    } catch {
      /* The action keeps its last summary. */
    }
    w.store.patch(action.id, { state: "cancelled", run });
    audit(s, item, "cancelled", "cancelled");
  }
  s.assistants.changed?.({ feeds: false });
}

const steps = {
  chat_turn: chatTurn,
  channel_input: channelEntry,
  channel_notice: channelEntry,
  workflow,
};

async function attempt(s, item, step) {
  try {
    await step(s, item);
  } catch {
    const verb = item.resolution === "cancel" || item.resolution === "stop";
    audit(s, item, verb ? "cancelled" : "updated", undefined, "failure");
  }
}

/**
 * Resolves the confirmed `items` in maintenance, then waits up to `waitMs` for runs
 * AgentPier cannot stop (a routine run, a chat summary, a command executing) while
 * nothing new may start. `current()` reads the blocker items again; what it returns
 * at the end is what remains.
 */
export async function resolveItems(s, items, current, { waitMs = 120000 } = {}) {
  const teams = items.filter((i) => i.kind === "team_task");
  for (const item of teams) await attempt(s, item, teamStop);
  for (const kind of ["chat_turn", "workflow"])
    for (const item of items.filter((i) => i.kind === kind))
      if (item.resolution !== "wait") await attempt(s, item, steps[kind]);
  for (const item of teams)
    try {
      await teamSettle(s, item);
    } catch {
      /* Reported as remaining work. */
    }
  for (const item of items.filter((i) => i.kind.startsWith("channel_")))
    await attempt(s, item, steps[item.kind]);
  const deadline = Date.now() + waitMs;
  let remaining = await current();
  while (
    remaining.length &&
    remaining.every((i) => i.resolution === "wait") &&
    Date.now() < deadline
  ) {
    await delay(Math.min(waitStepMs, Math.max(0, deadline - Date.now())));
    remaining = await current();
  }
  return remaining;
}
