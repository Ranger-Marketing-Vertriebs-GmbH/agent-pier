import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { peers } from "../helpers/peer-request-fixture.js";
import { ask, lead, until } from "../helpers/lead-request-service-fixture.js";
import { continuationPrompt } from "../../server/features/assistants/goal-turns.js";
import { nudgeDelayMs } from "../../server/features/assistants/work-goal-nudges.js";

// AGENTPIER-212: the follow-ups to work goals (AGENTPIER-208).
const owner = { kind: "owner" };

function setup(t) {
  const f = teamFixture(t);
  const agent = f.store.createAssistant({
    name: "Agent",
    instructions: "Work",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent-${agent.id}`,
  });
  return { f, agent, chat };
}

function turn(f, chat, context = owner, text = "Go") {
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text,
  });
  f.service.store.recordContext(request.id, context);
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  return { request, attempt, inv: { attemptId: attempt.id, assertCurrent() {} } };
}

async function setGoal(f, chat, title = "Episode") {
  const { request, attempt, inv } = turn(f, chat, owner, "Finish the episode");
  const { goal } = await f.service.goal(inv, { action: "set", title, done: "Cut" });
  f.complete(attempt.id);
  return { goal, anchor: request };
}

const sends = (f, chat) =>
  f.calls.filter(
    (c) =>
      c.method === "sessions.send" && (!chat || c.input.key === chat.runtimeSessionKey),
  );
const goalOf = (f, chat) => f.service.goals.store.list(chat.id).at(-1);

async function at(f, ms) {
  f.clock(ms);
  await f.service.goals.tick();
}

async function round(f, chat, start) {
  const before = sends(f, chat).length;
  await at(f, start);
  await at(f, start + nudgeDelayMs);
  assert.equal(sends(f, chat).length, before + 1, "one continuation");
  const request = f.assistants.ledger.latestRequest(chat.id);
  return { request, attempt: f.assistants.ledger.attemptFor(request.id) };
}

const tool = (f, runId, name) =>
  f.service.goals.observe({
    runId,
    stream: "item",
    data: { kind: "tool", itemId: `tool:${name}`, ...(name ? { name } : {}) },
  });

test("a continuation that only called agentpier_goal made no progress", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  const rounds = [["agentpier_goal"], ["agentpier_goal", "exec"], [undefined], []];
  const idle = [];
  for (const [n, tools] of rounds.entries()) {
    const { attempt } = await round(f, chat, n * 3 * nudgeDelayMs);
    for (const name of tools) tool(f, attempt.id, name);
    f.complete(attempt.id);
    await at(f, n * 3 * nudgeDelayMs + nudgeDelayMs + 1);
    idle.push(goalOf(f, chat).idleTurns);
  }
  // Only the goal tool: idle. Another tool, or one the event does not name: progress.
  assert.deepEqual(idle, [1, 0, 0, 1]);
  for (const n of [4, 5]) {
    const { attempt } = await round(f, chat, n * 3 * nudgeDelayMs);
    tool(f, attempt.id, "agentpier_goal");
    f.complete(attempt.id);
  }
  await at(f, 20 * nudgeDelayMs);
  assert.equal(goalOf(f, chat).state, "blocked");
  assert.equal(goalOf(f, chat).reasonCode, "no-progress");
});

test("a member's goal chat waits for a colleague's answer, not for its reports", async (t) => {
  const f = await peers(t);
  const chat = f.store.getConversation(f.fresh(f.permanent).conversationId);
  const set = f.memberTurn(f.permanent);
  await f.service.goal(set, { action: "set", title: "Research", done: "Notes" });
  f.settle();
  const r = f.peerAsk(f.memberTurn(f.permanent), f.second);
  f.settle();
  const before = sends(f, chat).length;
  await at(f, 0);
  await at(f, nudgeDelayMs);
  await at(f, 2 * nudgeDelayMs);
  assert.equal(sends(f, chat).length, before, "the colleague's answer comes here");
  f.service.store.write(f.service.requests.store.get(r.id), {
    phase: "completed",
    delivery: "failed",
    settled: true,
  });
  await at(f, 3 * nudgeDelayMs);
  await at(f, 4 * nudgeDelayMs);
  assert.equal(sends(f, chat).length, before + 1);
  // A colleague's answer for the lead goes to the lead's chat: no hold here.
  f.settle();
  f.peerAsk(f.memberTurn(f.permanent), f.second, {}, Date.now() + 1);
  const [peer] = f.service.requests.store
    .pending()
    .filter((x) => x.fromMemberId === f.permanent.id);
  f.service.store.write(peer, { resultTo: "lead" });
  f.settle();
  await at(f, 6 * nudgeDelayMs);
  await at(f, 7 * nudgeDelayMs);
  assert.equal(sends(f, chat).length, before + 2);
});

test("a colleague's answer for the lead holds the lead's goal chat", async (t) => {
  const f = await peers(t);
  await setGoal(f, f.chat);
  const r = f.peerAsk(f.memberTurn(f.permanent), f.second);
  f.service.store.write(f.service.requests.store.get(r.id), { resultTo: "lead" });
  f.settle();
  const before = sends(f, f.chat).length;
  await at(f, 0);
  await at(f, 2 * nudgeDelayMs);
  assert.equal(sends(f, f.chat).length, before);
  // A member's report is never waited for.
  f.service.store.write(f.service.requests.store.get(r.id), {
    type: "report",
    origin: { kind: "member-report" },
  });
  await at(f, 3 * nudgeDelayMs);
  await at(f, 4 * nudgeDelayMs);
  assert.equal(sends(f, f.chat).length, before + 1);
});

test("an interrupted continuation is reviewed and counts as a technical failure", async (t) => {
  const { f, agent, chat } = setup(t);
  await setGoal(f, chat);
  const entries = [];
  f.assistants.audit = { append: (entry) => entries.push(entry) };
  const { attempt } = await round(f, chat, 0);
  f.assistants.ledger.transition(attempt.id, "interrupted", {});
  await at(f, 2 * nudgeDelayMs);
  const reviewed = f.assistants.ledger.getAttempt(attempt.id);
  assert.equal(typeof reviewed.reviewedAt, "string");
  assert.equal(reviewed.state, "interrupted");
  const abort = f.calls.filter((c) => c.method === "sessions.abort");
  assert.deepEqual(
    abort.map((c) => c.input),
    [{ key: chat.runtimeSessionKey, runId: attempt.runtimeRunId || attempt.id }],
  );
  assert.equal(goalOf(f, chat).failures, 1);
  assert.equal(goalOf(f, chat).evaluatedAttemptId, attempt.id);
  const reviewEntry = entries.find((e) => e.details.change === "continuation-reviewed");
  assert.equal(reviewEntry.resourceId, agent.id);
  assert.equal(reviewEntry.source, "system");
  // The chat is free again: the next continuation follows after the delay.
  await round(f, chat, 3 * nudgeDelayMs);
});

test("a continuation the reconciler settled during the abort is not audited as reviewed", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  const entries = [];
  f.assistants.audit = { append: (entry) => entries.push(entry) };
  const { attempt } = await round(f, chat, 0);
  f.assistants.ledger.transition(attempt.id, "interrupted", {});
  const client = f.assistants.runtime.client,
    call = client.call;
  client.call = async (method, input) => {
    // Its end arrives while the abort is under way.
    if (method === "sessions.abort") f.assistants.ledger.transition(attempt.id, "failed");
    return call(method, input);
  };
  await at(f, 2 * nudgeDelayMs);
  assert.equal(f.assistants.ledger.getAttempt(attempt.id).reviewedAt, null);
  assert.ok(!entries.some((e) => e.details.change === "continuation-reviewed"));
  assert.equal(goalOf(f, chat).failures, 1, "the failed run still counts");
});

test("an uncertain continuation and the owner's interrupted turn wait for him", async (t) => {
  for (const which of ["uncertain continuation", "owner turn"]) {
    const { f, chat } = setup(t);
    await setGoal(f, chat);
    const id =
      which === "owner turn"
        ? turn(f, chat, owner).attempt.id
        : (await round(f, chat, 0)).attempt.id;
    f.assistants.ledger.transition(
      id,
      which === "owner turn" ? "interrupted" : "uncertain",
      {},
    );
    const before = sends(f, chat).length;
    await at(f, 2 * nudgeDelayMs);
    await at(f, 4 * nudgeDelayMs);
    assert.equal(f.assistants.ledger.getAttempt(id).reviewedAt, null, which);
    assert.ok(!f.calls.some((c) => c.method === "sessions.abort"), which);
    assert.equal(sends(f, chat).length, before, which);
    assert.equal(goalOf(f, chat).failures, 0, which);
  }
});

test("a continuation accepted before a crash is adopted, not sent anew", async (t) => {
  const { f, chat } = setup(t);
  const { goal, anchor } = await setGoal(f, chat);
  // The lost first delivery: accepted with its context, then the process went away
  // before it noted the continuation. Its run changed the steps meanwhile, and the
  // owner wrote again.
  const clientRequestId = `goal-continuation:${goal.id}:1`;
  const sent = await f.assistants.send(
    chat.id,
    { clientRequestId, text: continuationPrompt(goal) },
    {
      kind: "owner",
      goal: { id: goal.id, anchorRequestId: anchor.id, title: goal.title },
    },
  );
  f.complete(sent.attempt.id);
  f.service.goals.store.write(goalOf(f, chat), { steps: "1. Mix" });
  f.complete(turn(f, chat, { kind: "owner", teamAllowed: true }).attempt.id);
  const before = sends(f, chat).length;
  await at(f, 0);
  await at(f, nudgeDelayMs);
  assert.equal(sends(f, chat).length, before, "no second send");
  const adopted = goalOf(f, chat);
  assert.equal(adopted.nudges, 1);
  assert.equal(adopted.lastAttemptId, sent.attempt.id);
  assert.equal(adopted.failures, 0);
  // It ran unseen by this process: progress. The next continuation is a new one.
  const next = await round(f, chat, 2 * nudgeDelayMs);
  assert.equal(next.request.clientRequestId, `goal-continuation:${goal.id}:2`);
  assert.equal(goalOf(f, chat).idleTurns, 0);
});

test("a member result accepted before a crash keeps its recorded context", async (t) => {
  const f = await lead(t);
  const set = f.turn("Finish the episode");
  await f.service.goal(set, { action: "set", title: "Episode", done: "Cut" });
  f.idle();
  f.service.requests.waitMs = 0;
  await ask(f, f.permanent, f.turn("What is the budget?"));
  const r = f.requests().at(-1);
  f.complete(r.attemptId);
  f.idle();
  await f.service.reconcile();
  const first = await until(
    () => f.service.requests.store.get(r.id).resultAttemptId,
    "the follow-up",
  );
  const recorded = f.service.store.context(
    f.assistants.ledger.getAttempt(first).requestId,
  );
  assert.ok(recorded.goal, "delivered as a goal turn");
  // The crash lost the delivery's bookkeeping; the goal was stopped since.
  f.service.store.write(f.service.requests.store.get(r.id), {
    delivery: "pending",
    resultAttemptId: null,
    resultState: null,
    settled: false,
  });
  f.complete(first);
  f.service.goals.stop(f.chat.id);
  await f.service.requests.deliver(r.id);
  const after = f.service.requests.store.get(r.id);
  assert.equal(after.delivery, "sent");
  assert.equal(after.resultAttemptId, first);
  assert.ok(!after.deliveryFailures, "no conflict");
});

test("a turn of a replaced goal does not note the new goal's steps", async (t) => {
  const { f, chat } = setup(t);
  const { goal: old, anchor } = await setGoal(f, chat, "Old");
  const marker = { id: old.id, anchorRequestId: anchor.id, title: "Old" };
  const stale = turn(f, chat, { kind: "owner", goal: marker });
  await setGoal(f, chat, "New");
  await assert.rejects(
    f.service.goal(stale.inv, { action: "update", steps: "1. Wrong" }),
    (e) => e.key === "goalUpdateTurn" && e.status === 403,
  );
  assert.equal(f.service.goals.view(chat.id).steps, "");
  // A turn of the open goal and the owner's own turn still note them.
  const open = f.service.goals.store.open(chat.id);
  const current = { id: open.id, anchorRequestId: anchor.id, title: "New" };
  await f.service.goal(turn(f, chat, { kind: "owner", goal: current }).inv, {
    action: "update",
    steps: "1. Cut",
  });
  await f.service.goal(stale.inv, { action: "done", summary: "Ended anyway" });
  assert.equal(f.service.goals.view(chat.id), null);
});

test("an action named like an object property is invalid", async (t) => {
  const { f, chat } = setup(t);
  const { inv } = turn(f, chat);
  for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty"])
    await assert.rejects(
      f.service.goal(inv, { action }),
      (e) => e.key === "invalid",
      action,
    );
});

test("only the owner's stop control stops a continuation as his", async (t) => {
  for (const [byOwner, source] of [
    [false, "system"],
    [true, "user"],
  ]) {
    const { f, chat } = setup(t);
    await setGoal(f, chat);
    const entries = [];
    f.assistants.audit = { append: (entry) => entries.push(entry) };
    const { attempt } = await round(f, chat, 0);
    if (byOwner) f.service.goals.ownerCancel(attempt.id);
    f.assistants.ledger.transition(attempt.id, "cancelled");
    await at(f, 2 * nudgeDelayMs);
    assert.equal(goalOf(f, chat).reasonCode, "turn-cancelled");
    assert.equal(entries.at(-1).details.change, "stopped");
    assert.equal(entries.at(-1).source, source);
  }
});

test("a goal turn whose anchor proves no owner turn proposes no team on its own", async (t) => {
  const { f, chat } = setup(t);
  // An anchor whose context is gone reads as unknown (goal-turns.js ownerSource).
  const { request } = turn(f, chat, { kind: "routine" });
  const goal = { id: "g", anchorRequestId: request.id, title: "Episode" };
  const { team } = await f.proposal({ count: 1, context: { kind: "owner", goal } });
  const stored = f.service.store.get(team.id);
  assert.equal(stored.authorization, null);
  assert.equal(stored.phase, "awaiting_approval");
});
