import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { WorkGoalStore } from "../../server/features/assistants/work-goal-store.js";
import { forgetChat } from "../../server/features/assistants/chat-removal.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// An owner's agent with one chat; `body` patches the stored agent record.
function setupAgent(f, body = {}, chatInput = {}) {
  const agent = f.store.createAssistant({
    name: "Agent",
    instructions: "Work",
    model: { connectionId: "c", modelId: "m" },
  });
  if (Object.keys(body).length)
    f.store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify({ ...f.store.storedAssistant(agent.id), ...body }), agent.id);
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent-${agent.id}-${crypto.randomUUID()}`,
    ...chatInput,
  });
  return { agent, chat };
}

function turn(f, chat, context, text = "Go") {
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text,
  });
  f.service.store.recordContext(request.id, context);
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  const inv = { attemptId: attempt.id, toolCallId: "call", assertCurrent() {} };
  return { request, attempt, inv };
}

function audits(f) {
  const entries = [];
  f.assistants.audit = { append: (entry) => entries.push(entry) };
  return entries;
}

const owner = { kind: "owner" };

test("the owner's own turn sets a goal and a new one replaces it", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  const { inv, request } = turn(f, chat, owner, "Finish the episode");
  const { goal } = await f.service.goal(inv, {
    action: "set",
    title: "Episode",
    done: "Review cut",
  });
  assert.equal(goal.state, "open");
  assert.deepEqual(Object.keys(goal).sort(), [
    "createdAt",
    "done",
    "id",
    "state",
    "steps",
    "title",
  ]);
  assert.equal(f.service.goals.store.open(chat.id).anchorRequestId, request.id);
  assert.equal(f.service.goals.store.open(chat.id).setRequestId, request.id);
  const next = turn(f, chat, { kind: "telegram", channelId: "c" }, "Now the trailer");
  await f.service.goal(next.inv, { action: "set", title: "Trailer", done: "Cut" });
  const [old, open] = f.service.goals.store.list(chat.id);
  assert.equal(old.state, "replaced");
  assert.equal(open.title, "Trailer");
  assert.equal(f.service.goals.store.open(chat.id).id, open.id);
  assert.deepEqual(
    f.service.goals.notes(chat.id).map((n) => n.phase),
    ["set", "replaced", "set"],
  );
  assert.deepEqual(
    f.service.goals.store.openGoals().map((g) => g.id),
    [open.id],
  );
});

test("goal input takes exactly the keys of its action", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  const { inv } = turn(f, chat, owner);
  for (const input of [
    { action: "set", title: "T" },
    { action: "set", title: "T", done: "D", extra: 1 },
    { action: "set", title: "x".repeat(121), done: "D" },
    { action: "set", title: "T", done: "D", steps: 3 },
    { action: "launch", title: "T", done: "D" },
    null,
  ])
    await assert.rejects(f.service.goal(inv, input), (e) => e.key === "invalid");
  await f.service.goal(inv, { action: "set", title: "T", done: "D", steps: "1. A" });
  await assert.rejects(
    f.service.goal(inv, { action: "update", steps: "2. B", title: "X" }),
    (e) => e.key === "invalid",
  );
  await assert.rejects(
    f.service.goal(inv, { action: "done" }),
    (e) => e.key === "invalid",
  );
  assert.equal(f.service.goals.view(chat.id).steps, "1. A");
});

test("no goal from forwarded, delegated, scheduled or continuation turns", async (t) => {
  for (const context of [
    { kind: "owner", forwarded: true },
    { kind: "telegram", forwarded: true },
    { kind: "lead-request", requestId: "r" },
    { kind: "member-result", requestId: "r" },
    { kind: "ssh-result", actionId: "a" },
    { kind: "routine" },
    { kind: "memory-step" },
    { kind: "owner", goal: { id: "g", anchorRequestId: "r", title: "T" } },
  ]) {
    const f = teamFixture(t),
      { chat } = setupAgent(f);
    await assert.rejects(
      f.service.goal(turn(f, chat, context).inv, {
        action: "set",
        title: "T",
        done: "D",
      }),
      (e) => e.key === "goalOwnerTurn" && e.status === 403,
      context.kind,
    );
    assert.equal(f.service.goals.store.open(chat.id), null);
  }
});

test("a run without an attempt keeps no goal", async (t) => {
  const f = teamFixture(t);
  setupAgent(f);
  await assert.rejects(
    f.service.goal(
      { attemptId: null, routine: { id: "r" }, assertCurrent() {} },
      { action: "set", title: "T", done: "D" },
    ),
    (e) => e.key === "goalUnavailable",
  );
});

test("shared, user and temporary agents and users' chats keep no goals", async (t) => {
  const cases = [
    (f) => setupAgent(f, { userAccess: { mode: "shared", members: [], released: [] } }),
    (f) => setupAgent(f, { userAccess: { mode: "own", members: [], released: [] } }),
    (f) => {
      const parent = setupAgent(f).agent;
      const agent = f.store.reserveMember({
        id: "member",
        parent: parent.id,
        teamId: "team",
        lifetime: "task",
        assignment: { name: "Member", role: "Review", assignment: "Review" },
        snapshot: parent,
      });
      const chat = f.store.saveConversation({
        assistantId: agent.id,
        runtimeSessionKey: "member-chat",
      });
      return { agent, chat };
    },
    (f) => setupAgent(f, {}, { userId: "anna" }),
  ];
  for (const make of cases) {
    const f = teamFixture(t),
      { chat } = make(f);
    await assert.rejects(
      f.service.goal(turn(f, chat, owner).inv, { action: "set", title: "T", done: "D" }),
      (e) => e.key === "goalUnavailable" && e.status === 409,
    );
    assert.equal(f.service.goals.store.open(chat.id), null);
  }
});

test("done, blocked and update need an open goal and end it visibly", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  const { inv } = turn(f, chat, owner);
  await assert.rejects(
    f.service.goal(inv, { action: "update", steps: "1. A" }),
    (e) => e.key === "goalNotOpen" && e.status === 409,
  );
  await f.service.goal(inv, { action: "set", title: "Episode", done: "Cut" });
  const updated = await f.service.goal(inv, {
    action: "update",
    steps: "1. Cut\n2. Mix",
  });
  assert.equal(updated.goal.steps, "1. Cut\n2. Mix");
  assert.equal(f.service.goals.view(chat.id).steps, "1. Cut\n2. Mix");
  const ended = await f.service.goal(inv, { action: "done", summary: "Cut and mixed" });
  assert.equal(ended.goal, null);
  assert.equal(f.service.goals.store.list(chat.id)[0].state, "done");
  assert.equal(f.service.goals.view(chat.id), null);
  const last = f.service.goals.notes(chat.id).at(-1);
  assert.equal(last.phase, "done");
  assert.equal(last.text, "Cut and mixed");
  assert.equal(last.event, "goal");
  assert.equal(last.role, "event");
  assert.equal(last.runId, null);
  assert.equal(last.title, "Episode");
  await assert.rejects(
    f.service.goal(inv, { action: "done", summary: "Again" }),
    (e) => e.key === "goalNotOpen",
  );
  await f.service.goal(inv, { action: "set", title: "Trailer", done: "Cut" });
  const member = turn(f, chat, { kind: "member-result", requestId: "r" });
  await f.service.goal(member.inv, { action: "blocked", reason: "Needs the music" });
  assert.equal(f.service.goals.store.list(chat.id).at(-1).state, "blocked");
  const note = f.service.goals.notes(chat.id).at(-1);
  assert.equal(note.phase, "blocked");
  assert.equal(note.text, "Needs the music");
});

test("goal problems reach the model as their codes", () => {
  const codes = {
    goalOwnerTurn: ["GOAL_OWNER_TURN", 403],
    goalOwnerOnly: ["GOAL_OWNER_ONLY", 403],
    goalUnavailable: ["GOAL_UNAVAILABLE", 409],
    goalNotOpen: ["GOAL_NOT_OPEN", 409],
  };
  for (const [key, [code, status]] of Object.entries(codes)) {
    const result = toolError({ key, status });
    assert.equal(result.code, code);
    assert.match(result.reason, /Do not retry/);
  }
});

test("stop ends the open goal without touching the running turn", async (t) => {
  const f = teamFixture(t),
    { chat, agent } = setupAgent(f);
  const entries = audits(f);
  await f.service.goal(turn(f, chat, owner).inv, {
    action: "set",
    title: "T",
    done: "D",
  });
  assert.deepEqual(f.service.goals.stop(chat.id), { goal: null });
  assert.equal(f.service.goals.store.list(chat.id)[0].state, "stopped");
  assert.ok(!f.calls.some((c) => c.method === "sessions.abort"));
  const stopped = entries.at(-1);
  assert.equal(stopped.details.change, "stopped");
  assert.equal(stopped.source, "user");
  assert.equal(stopped.resourceId, agent.id);
  assert.deepEqual(f.service.goals.stop(chat.id), { goal: null });
  assert.equal(entries.length, 2);
});

test("end records its reason code and ended state", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  await f.service.goal(turn(f, chat, owner).inv, {
    action: "set",
    title: "T",
    done: "D",
  });
  const goal = f.service.goals.end(f.service.goals.store.open(chat.id), "ended", {
    reasonCode: "archived",
  });
  assert.equal(goal.state, "ended");
  assert.equal(goal.reasonCode, "archived");
  assert.equal(typeof goal.endedAt, "number");
  const note = f.service.goals.notes(chat.id).at(-1);
  assert.equal(note.phase, "ended");
  assert.equal(note.reasonCode, "archived");
  assert.ok(!("text" in note));
});

test("at most 20 ended goals per chat are kept", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  const { inv } = turn(f, chat, owner);
  for (let n = 0; n < 23; n++)
    await f.service.goal(inv, { action: "set", title: `Goal ${n}`, done: "D" });
  const list = f.service.goals.store.list(chat.id);
  assert.equal(list.length, 21);
  assert.equal(list.filter((g) => g.state === "open").length, 1);
  assert.equal(list[0].title, "Goal 2");
});

test("goal records survive a new service on the same database", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  await f.service.goal(turn(f, chat, owner).inv, {
    action: "set",
    title: "Durable",
    done: "D",
  });
  const store = new WorkGoalStore(new TeamStore({ store: f.store }));
  assert.equal(store.open(chat.id).title, "Durable");
});

test("audit entries name the change, never the goal's text", async (t) => {
  const f = teamFixture(t),
    { chat, agent } = setupAgent(f);
  const entries = audits(f);
  const { inv } = turn(f, chat, owner);
  await f.service.goal(inv, {
    action: "set",
    title: "Secret title",
    done: "Secret done",
  });
  await f.service.goal(inv, { action: "update", steps: "Secret steps" });
  await f.service.goal(inv, { action: "set", title: "Secret two", done: "Secret done" });
  await f.service.goal(inv, { action: "blocked", reason: "Secret reason" });
  assert.deepEqual(
    entries.map((e) => e.details.change),
    ["set", "updated", "replaced", "set", "blocked"],
  );
  for (const entry of entries) {
    assert.equal(entry.action, "assistant.updated");
    assert.equal(entry.resourceType, "assistant");
    assert.equal(entry.resourceId, agent.id);
    assert.equal(entry.source, "system");
    assert.equal(entry.outcome, "success");
    assert.equal(entry.details.kind, "work-goal");
    assert.equal(entry.details.conversationId, chat.id);
    assert.equal(typeof entry.details.goalId, "string");
  }
  assert.ok(!JSON.stringify(entries).includes("Secret"));
});

test("a deleted chat takes its goals with it", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  await f.service.goal(turn(f, chat, owner).inv, {
    action: "set",
    title: "T",
    done: "D",
  });
  await forgetChat(f.assistants, chat);
  assert.deepEqual(f.service.goals.store.list(chat.id), []);
});

test("only the owner's direct turn or a goal turn updates the steps", async (t) => {
  const f = teamFixture(t),
    { chat } = setupAgent(f);
  const set = turn(f, chat, owner, "Finish the episode");
  const { goal } = await f.service.goal(set.inv, {
    action: "set",
    title: "Episode",
    done: "Cut",
  });
  const update = (context, steps) =>
    f.service.goal(turn(f, chat, context).inv, { action: "update", steps });
  for (const context of [
    { kind: "owner", forwarded: true },
    { kind: "lead-request", requestId: "r", leadAssistantId: "lead" },
    { kind: "member-result", requestId: "r" },
    { kind: "routine", bindingId: "b", name: "Daily" },
  ])
    await assert.rejects(
      update(context, "1. Wrong"),
      (e) => e.key === "goalOwnerTurn" && e.status === 403,
      JSON.stringify(context),
    );
  assert.equal(f.service.goals.view(chat.id).steps, "");
  const marker = { id: goal.id, anchorRequestId: set.request.id, title: "Episode" };
  await update({ kind: "owner", goal: marker }, "1. Cut");
  assert.equal(f.service.goals.view(chat.id).steps, "1. Cut");
  await update({ kind: "telegram", channelId: "c" }, "1. Cut\n2. Mix");
  assert.equal(f.service.goals.view(chat.id).steps, "1. Cut\n2. Mix");
  // Ending stays open to any turn of the chat.
  await f.service.goal(turn(f, chat, { kind: "owner", forwarded: true }).inv, {
    action: "done",
    summary: "Cut",
  });
  assert.equal(f.service.goals.view(chat.id), null);
});
