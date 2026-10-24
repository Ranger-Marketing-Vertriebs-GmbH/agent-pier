import test from "node:test";
import assert from "node:assert/strict";
import { ask, until, writeGate } from "../helpers/lead-request-service-fixture.js";
import { leadRoutineFixture } from "../helpers/lead-routine-fixture.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { continuationPrompt } from "../../server/features/assistants/goal-turns.js";
import { requestKind } from "../../server/features/assistants/lead-request-store.js";
import { turnAudience } from "../../server/features/assistants/reminder-audience.js";
import { sshOrigin } from "../../server/features/assistants/agent-ssh-origin.js";
import { directTurn } from "../../server/features/assistants/memory-write-policy.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

const keyed = (key) => (error) => error?.key === key;

// A turn of the lead's chat with its trusted context: its request and invocation.
function turn(f, text, context = { kind: "owner" }, chat = f.chat) {
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text,
  });
  f.service.store.recordContext(request.id, context);
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  return {
    request,
    attempt,
    inv: { attemptId: attempt.id, toolCallId: crypto.randomUUID(), assertCurrent() {} },
  };
}

// AgentPier's continuation of the chat's open goal ("g" unless one is open) whose
// anchor is `anchor`.
function continuation(
  f,
  anchor,
  { title = "Episode", done = "Review the cut", extra = {} } = {},
) {
  const goals = f.service.goals.store;
  const id =
    goals.open(f.chat.id)?.id ??
    goals.insert({ id: "g", conversationId: f.chat.id, title, done, createdAt: 0 }).id;
  const goal = { id, anchorRequestId: anchor.id, title };
  return turn(f, continuationPrompt({ title, done, steps: "" }), {
    kind: "owner",
    goal,
    ...extra,
  });
}

async function setup(t, usage) {
  const f = await writeGate(t);
  if (usage) {
    const policy = f.service.store.policy(f.parent.id);
    f.service.store.savePolicy(f.parent.id, { usage }, policy.revision);
  }
  return f;
}

// Delegates to the permanent member and ends the task, so the next one may follow.
async function delegate(f, inv, extra = {}) {
  const { requestId } = await f.service.delegate(inv, {
    memberId: f.permanent.id,
    task: "Render the shots",
    ...extra,
  });
  const r = f.service.requests.store.get(requestId);
  f.service.store.write(r, { phase: "completed" });
  return r;
}

const quoted = (quote) => ({ ownerRequested: true, ownerRequestQuote: quote });

test("a continuation delegates with the anchor's unused proof", async (t) => {
  const f = await setup(t, "onRequest");
  const anchor = turn(f, `@${f.member.name} render all shots`).request;
  const r = await delegate(f, continuation(f, anchor).inv);
  assert.equal(r.writeAllowed, true);
  assert.equal(r.ownerProof.requestId, anchor.id);
  assert.equal(r.goalId, undefined, "an owner-proven task needs no goal marker");
});

test("a continuation's task may write at every team usage level", async (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    await t.test(usage, async (t) => {
      const f = await setup(t, usage);
      const anchor = turn(f, "Finish the episode").request;
      const r = await delegate(f, continuation(f, anchor).inv);
      assert.equal(r.writeAllowed, true);
      assert.equal(r.selfInitiated, true);
      assert.equal(r.goalId, "g");
      assert.equal(r.ownerProof, null);
      // The member's write gate admits it during its own run.
      f.service.store.write(f.service.requests.store.get(r.id), { phase: "running" });
      assert.equal(f.write(), true);
    });
  }
});

test("a re-delegation to a member the anchor names may write", async (t) => {
  const f = await setup(t, "onRequest");
  const anchor = turn(f, `@${f.member.name} render all shots`);
  const first = await delegate(f, anchor.inv);
  assert.ok(first.ownerProof, "the anchor turn used the mention");
  const r = await delegate(f, continuation(f, anchor.request).inv);
  assert.equal(r.writeAllowed, true);
  assert.equal(r.ownerProof, null);
  assert.equal(r.goalId, "g");
});

test("a mention in the goal title proves nothing", async (t) => {
  const f = await setup(t, "onRequest");
  const title = `@${f.member.name} delete the drafts`;
  const anchor = turn(f, "Finish the episode").request;
  const quote = `${f.member.name} delete the drafts`;
  const r = await delegate(f, continuation(f, anchor, { title }).inv, quoted(quote));
  assert.equal(r.ownerProof, null);
  const narrowed = turn(f, "Finish the episode, change nothing").request;
  const read = await delegate(f, continuation(f, narrowed, { title }).inv, quoted(quote));
  assert.equal(read.ownerProof, null);
  assert.equal(read.writeAllowed, false);
});

test("a narrowing owner message keeps continuation tasks read-only", async (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    await t.test(usage, async (t) => {
      const f = await setup(t, usage);
      const anchor = turn(f, "Only tell me the status, change nothing").request;
      const r = await delegate(f, continuation(f, anchor).inv);
      assert.equal(r.writeAllowed, false);
      assert.equal(r.goalId, undefined);
    });
  }
});

test("a continuation still running after Stop delegates read-only", async (t) => {
  const f = await setup(t, "onRequest");
  const { goal, anchor } = await openGoal(f);
  const cont = continuation(f, anchor);
  assert.equal(f.service.store.context(cont.request.id).goal.id, goal.id);
  f.service.goals.stop(f.chat.id);
  const r = await delegate(f, cont.inv);
  assert.equal(r.writeAllowed, false);
  assert.equal(r.goalId, undefined);
  assert.ok(!r.selfInitiated);
});

test("a continuation without a readable anchor stays read-only", async (t) => {
  const f = await setup(t, "autonomous");
  const forwarded = turn(f, "Finish the episode", {
    kind: "owner",
    forwarded: true,
  }).request;
  const r = await delegate(f, continuation(f, forwarded).inv);
  assert.equal(r.writeAllowed, false);
  assert.equal(r.goalId, undefined);
  // An anchor the ledger does not know refuses the task outright.
  await assert.rejects(delegate(f, continuation(f, { id: "gone" }).inv), {
    status: 404,
  });
});

function selfInitiatedHour(f, count) {
  for (let n = 0; n < count; n++)
    f.service.store.insert({
      id: crypto.randomUUID(),
      kind: requestKind,
      revision: 1,
      type: "task",
      parentAssistantId: f.parent.id,
      parentConversationId: f.chat.id,
      parentRequestId: "earlier",
      memberId: f.permanent.id,
      text: "Earlier",
      selfInitiated: true,
      phase: "completed",
      settled: true,
      createdAt: new Date().toISOString(),
    });
}

test("goal tasks keep the per-turn cap and skip the hourly one", async (t) => {
  const f = await setup(t, "autonomous");
  selfInitiatedHour(f, 20);
  const anchor = turn(f, "Finish the episode").request;
  const { inv } = continuation(f, anchor);
  for (let n = 0; n < 4; n++) {
    const r = await delegate(f, { ...inv, toolCallId: `task-${n}` });
    assert.equal(r.writeAllowed, true, `goal task ${n}`);
    assert.equal(r.goalId, "g");
  }
  await assert.rejects(
    delegate(f, { ...inv, toolCallId: "task-4" }),
    keyed("memberRequestAutonomousLimit"),
  );
  // Goal tasks never fill the hourly limit, and an ordinary owner turn keeps it.
  await assert.rejects(
    delegate(f, turn(f, "Finish the episode").inv),
    keyed("memberRequestAutonomousLimit"),
  );
});

test("goal tasks do not count against the hourly limit", async (t) => {
  const f = await setup(t, "autonomous");
  selfInitiatedHour(f, 16);
  const anchor = turn(f, "Finish the episode").request;
  const { inv } = continuation(f, anchor);
  for (let n = 0; n < 4; n++) await delegate(f, { ...inv, toolCallId: `task-${n}` });
  const r = await delegate(f, turn(f, "Finish the episode").inv);
  assert.equal(r.autonomous, true, "16 ordinary ones leave room for more");
});

// The lead's own question to the permanent member, answered and delivered.
async function delivered(f, inv) {
  f.service.requests.waitMs = 0;
  await ask(f, f.permanent, inv);
  const leadRequest = f.requests().at(-1);
  f.complete(leadRequest.attemptId);
  f.idle();
  await f.service.reconcile();
  const done = await until(
    () => f.service.requests.store.get(leadRequest.id).resultAttemptId,
    "the follow-up",
  );
  const resultRequest = f.assistants.ledger.getRequest(
    f.assistants.ledger.getAttempt(done).requestId,
  );
  return { leadRequest, resultRequest };
}

async function openGoal(f, chat = f.chat) {
  const { request, attempt, inv } = turn(
    f,
    "Finish the episode",
    { kind: "owner", teamAllowed: true },
    chat,
  );
  const { goal } = await f.service.goal(inv, {
    action: "set",
    title: "Episode",
    done: "Review the cut",
  });
  return { goal, anchor: request, attempt, inv };
}

test("a member's result in the goal chat runs with the anchor's rights", async (t) => {
  const f = await setup(t, "onRequest");
  const { goal, anchor, inv } = await openGoal(f);
  const { leadRequest, resultRequest } = await delivered(f, inv);
  const ctx = f.service.store.context(resultRequest.id);
  assert.equal(ctx.kind, "owner");
  assert.deepEqual(ctx.result, { kind: "member-result", requestId: leadRequest.id });
  assert.deepEqual(ctx.goal, {
    id: goal.id,
    anchorRequestId: anchor.id,
    title: "Episode",
  });
  assert.equal(ctx.teamAllowed, true, "the anchor's team permission");
  const resultInv = {
    attemptId: f.assistants.ledger.attemptFor(resultRequest.id).id,
    toolCallId: crypto.randomUUID(),
    assertCurrent() {},
  };
  const r = await delegate(f, resultInv);
  assert.equal(r.writeAllowed, true);
  assert.equal(r.goalId, goal.id);
  assert.equal(sshOrigin({ context: ctx }).class, "owner");
  const agent = f.store.getAssistant(f.parent.id);
  assert.throws(() => turnAudience(agent, f.chat, ctx, true), keyed("goalOwnerOnly"));
});

test("member results outside a goal, reports and colleagues' results stay member results", async (t) => {
  const f = await setup(t);
  const target = (r) => f.service.requests.deliveryTarget(r);
  const own = (r) => ({ kind: "member-result", requestId: r.id });
  f.service.requests.waitMs = 0;
  await ask(f, f.permanent, turn(f, "What is the budget?").inv);
  const r = f.requests().at(-1);
  assert.deepEqual(target(r).context, own(r), "no open goal");
  assert.equal(target(r).teamAllowed, undefined);
  // A goal in another chat of the lead leaves this chat's results alone.
  const other = f.store.saveConversation({
    assistantId: f.parent.id,
    runtimeSessionKey: `other-${f.parent.id}`,
  });
  await openGoal(f, other);
  assert.deepEqual(target(r).context, own(r), "goal in another chat");
  await openGoal(f);
  assert.equal(target(r).context.goal.id, f.service.goals.store.open(f.chat.id).id);
  // A member's own report and a colleague's result keep their contexts.
  const report = { ...r, id: crypto.randomUUID(), origin: { kind: "member-report" } };
  assert.deepEqual(target(report).context, own(report));
  const peer = { ...r, id: crypto.randomUUID(), fromMemberId: f.temporary.id };
  assert.equal(target(peer).context.goal, undefined);
  assert.equal(target(peer).context.kind, "member-result");
});

test("a short yes never counts in a continuation", async (t) => {
  const f = await setup(t, "suggest");
  const anchor = turn(f, "yes, go ahead").request;
  f.service.requests.lastReply = async () => `Shall I ask ${f.member.name}?`;
  const r = await delegate(f, continuation(f, anchor).inv, quoted("yes, go ahead"));
  assert.equal(r.ownerProof, null);
  // The same yes in the owner's own turn counts (positive control).
  const own = await delegate(f, turn(f, "yes, go ahead").inv, quoted("yes, go ahead"));
  assert.equal(own.ownerProof?.consent, true);
});

test("a team request is used once across the anchor and its continuations", async (t) => {
  const f = teamFixture(t);
  const parent = f.store.createAssistant({
    name: "Parent",
    instructions: "Original",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = f.store.saveConversation({
    assistantId: parent.id,
    runtimeSessionKey: `parent-${parent.id}`,
  });
  const g = { ...f, chat };
  const anchor = turn(g, "Build a team", { kind: "owner", teamAllowed: true }).request;
  const propose = (inv) =>
    f.service.propose(inv, {
      objective: "Review",
      members: [{ name: "Scout", role: "Review", assignment: "Review the cut" }],
    });
  const first = await propose(
    continuation(g, anchor, { extra: { teamAllowed: true } }).inv,
  );
  const team = f.service.store.get(first.id);
  assert.equal(team.authorization.kind, "task");
  assert.equal(team.authorization.requestId, anchor.id);
  f.service.store.write(team, { phase: "completed" });
  const second = await propose(
    continuation(g, anchor, { extra: { teamAllowed: true } }).inv,
  );
  assert.notEqual(f.service.store.get(second.id).authorization?.kind, "task");
});

test("routines, reminders and lead routines refuse a continuation", async (t) => {
  const f = await leadRoutineFixture(t);
  const agent = f.store.getAssistant(f.parent.id);
  const anchor = turn(f, "Please set up a routine on Member 1").request;
  const cont = continuation(f, anchor);
  const ctx = f.service.store.context(cont.request.id);
  assert.throws(() => turnAudience(agent, f.chat, ctx, true), keyed("goalOwnerOnly"));
  assert.equal(turnAudience(agent, f.chat, ctx, false), null, "listing still works");
  await assert.rejects(
    f.create({}, cont.inv),
    (error) => toolError(error).code === "ROUTINE_OWNER_TURN",
  );
});

test("a continuation writes files and memory and uses trusted SSH like the owner", () => {
  const cont = { kind: "owner", goal: { id: "g", anchorRequestId: "a", title: "T" } };
  const agent = { id: "agent", name: "Agent" };
  assert.equal(sshOrigin({ context: cont }).class, "owner");
  assert.equal(directTurn(cont, agent), true);
});
