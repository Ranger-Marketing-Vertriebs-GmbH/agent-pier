import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { backgroundMethod } from "../../server/features/assistants/team-plugin/background-commands.js";
import {
  backgroundRunning,
  backgroundWaitMs,
  goalWait,
  nudgeDelayMs,
} from "../../server/features/assistants/work-goal-nudges.js";

const owner = { kind: "owner" };

// An owner's agent with one chat; `body` patches the stored agent record.
function setup(t, body = {}) {
  const f = teamFixture(t);
  const agent = f.store.createAssistant({
    name: "Agent",
    instructions: "Work",
    model: { connectionId: "c", modelId: "m" },
  });
  if (Object.keys(body).length) patchAgent(f, agent, body);
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent-${agent.id}`,
  });
  return { f, agent, chat };
}

function patchAgent(f, agent, body) {
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...f.store.storedAssistant(agent.id), ...body }), agent.id);
}

// A turn of the chat with its trusted context, left pending.
function turn(f, chat, context = owner, text = "Go") {
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text,
  });
  f.service.store.recordContext(request.id, context);
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  return { request, attempt, inv: { attemptId: attempt.id, assertCurrent() {} } };
}

// The owner's turn that sets the goal, ended.
async function setGoal(f, chat, context = owner) {
  const { request, attempt, inv } = turn(f, chat, context, "Finish the episode");
  const { goal } = await f.service.goal(inv, {
    action: "set",
    title: "Episode",
    done: "Review cut",
  });
  f.complete(attempt.id);
  return { goal, anchor: request };
}

const sends = (f) => f.calls.filter((c) => c.method === "sessions.send");
const goalOf = (f, chat) => f.service.goals.store.list(chat.id).at(-1);

async function at(f, ms) {
  f.clock(ms);
  await f.service.goals.tick();
}

// Ticks the idle chat until a continuation goes out: its request and attempt.
async function round(f, chat, start) {
  const before = sends(f).length;
  await at(f, start);
  await at(f, start + nudgeDelayMs);
  assert.equal(sends(f).length, before + 1, "one continuation");
  const request = f.assistants.ledger.latestRequest(chat.id);
  return { request, attempt: f.assistants.ledger.attemptFor(request.id) };
}

// The Gateway's background commands of every session: `running()` decides, and
// `completing()` for OpenClaw 2026.10.7's completion runs.
function background(f, running, completing = () => false) {
  const client = f.assistants.runtime.client,
    call = client.call;
  client.call = async (method, input) =>
    method === backgroundMethod
      ? {
          complete: true,
          running: running() ? 1 : 0,
          completing: completing() ? 1 : 0,
        }
      : call(method, input);
}

function actions(f) {
  const store = new AssistantActionStore(f.store.db);
  f.assistants.workflows = { store, async close() {} };
  return (agent, chat, body) => {
    const id = crypto.randomUUID();
    f.store.db
      .prepare("INSERT INTO assistant_actions VALUES (?,?,?,?)")
      .run(
        id,
        agent.id,
        id,
        JSON.stringify({ id, assistantId: agent.id, conversationId: chat.id, ...body }),
      );
    return id;
  };
}

function record(f, agent, chat, body) {
  return f.service.store.insert({
    id: crypto.randomUUID(),
    revision: 1,
    parentAssistantId: agent.id,
    parentConversationId: chat.id,
    ...body,
  });
}

test("a continuation follows 90 seconds after the turn ends", async (t) => {
  const { f, chat } = setup(t);
  const { goal, anchor } = await setGoal(f, chat);
  await at(f, 0);
  assert.equal(sends(f).length, 0);
  await at(f, nudgeDelayMs - 1);
  assert.equal(sends(f).length, 0);
  await at(f, nudgeDelayMs);
  const [sent] = sends(f);
  assert.equal(sends(f).length, 1);
  assert.match(
    sent.input.message ?? sent.input.text,
    /^This is AgentPier, not the owner\./,
  );
  const request = f.assistants.ledger.latestRequest(chat.id);
  assert.deepEqual(f.service.store.context(request.id).goal, {
    id: goal.id,
    anchorRequestId: anchor.id,
    title: "Episode",
  });
  assert.equal(f.service.store.context(request.id).kind, "owner");
  assert.equal(request.clientRequestId, `goal-continuation:${goal.id}:1`);
  const stored = goalOf(f, chat);
  assert.equal(stored.nudges, 1);
  assert.equal(stored.lastAttemptId, f.assistants.ledger.attemptFor(request.id).id);
  // While the continuation runs, nothing more goes out.
  await at(f, 3 * nudgeDelayMs);
  assert.equal(sends(f).length, 1);
});

test("the nudge waits while the chat waits on the owner or on results", async (t) => {
  const cases = {
    "pending attempt": (f, { chat }) => {
      const { attempt } = turn(f, chat, { kind: "routine" });
      return () => f.assistants.ledger.transition(attempt.id, "completed");
    },
    "heartbeat run": (f, { chat }) => {
      const run = { runId: "hb", sessionKey: chat.runtimeSessionKey, isHeartbeat: true };
      f.assistants.completionRuns.observe({ ...run, stream: "assistant" });
      return () =>
        f.assistants.completionRuns.observe({
          ...run,
          stream: "lifecycle",
          data: { phase: "end" },
        });
    },
    // OpenClaw 2026.10.7: a completion run the transcript proved (its agent events
    // carry no mark), and one the Gateway's record knows before it wrote anything.
    "verified 10.7 completion run": (f, { chat }) => {
      const runs = f.assistants.completionRuns;
      runs.admit("turn-1", chat.runtimeSessionKey);
      const run = { runId: "turn-1", sessionKey: chat.runtimeSessionKey };
      runs.observe({ ...run, isHeartbeat: false, stream: "assistant" });
      return () => runs.observe({ ...run, stream: "lifecycle", data: { phase: "end" } });
    },
    "10.7 completion run": (f) => {
      let completing = true;
      background(
        f,
        () => false,
        () => completing,
      );
      return () => (completing = false);
    },
    "queued message": (f, { chat }) => {
      f.assistants.queued.put(chat.id, { text: "Later", attachments: [] });
      return () => f.assistants.queued.take(chat.id);
    },
    "awaiting approval": (f, { agent, chat }) => {
      const id = actions(f)(agent, chat, {
        state: "awaiting_approval",
        payload: { action: "exec" },
      });
      return () =>
        f.assistants.workflows.store.patch(id, { state: "declined", settled: true });
    },
    "ssh follow-up": (f, { agent, chat }) => {
      const id = actions(f)(agent, chat, {
        state: "completed",
        followUp: true,
        payload: { action: "ssh" },
      });
      return () => f.assistants.workflows.store.patch(id, { followUpSent: true });
    },
    "team proposal": (f, { agent, chat }) => {
      const team = record(f, agent, chat, { kind: "team", phase: "awaiting_approval" });
      return () => f.service.store.write(team, { phase: "declined" });
    },
    "lead request": (f, { agent, chat }) => {
      const r = record(f, agent, chat, {
        kind: "lead-request",
        type: "question",
        phase: "running",
        delivery: null,
      });
      return () => f.service.store.write(r, { phase: "completed", settled: true });
    },
    "active team": (f, { agent, chat }) => {
      const team = record(f, agent, chat, { kind: "team", phase: "running" });
      return () => f.service.store.write(team, { phase: "completed" });
    },
    "background command": (f) => {
      let running = true;
      background(f, () => running);
      return () => (running = false);
    },
  };
  for (const [name, hold] of Object.entries(cases)) {
    const { f, agent, chat } = setup(t);
    await setGoal(f, chat);
    const clear = hold(f, { agent, chat });
    await at(f, 0);
    await at(f, nudgeDelayMs);
    await at(f, 2 * nudgeDelayMs);
    assert.equal(sends(f).length, 0, name);
    clear();
    const cleared = 3 * nudgeDelayMs;
    await at(f, cleared);
    await at(f, cleared + nudgeDelayMs - 1);
    assert.equal(sends(f).length, 0, name);
    await at(f, cleared + nudgeDelayMs);
    assert.equal(sends(f).length, 1, name);
  }
});

test("a live 10.7 completion run holds the nudge", async (t) => {
  // Review Focus 3: no agent event marks it, yet the chat is busy while it runs.
  const { f, chat } = setup(t);
  const runs = f.assistants.completionRuns;
  runs.admit("turn-1", chat.runtimeSessionKey);
  assert.equal(goalWait(f.service.goals, chat), "busy");
  runs.observe({
    runId: "turn-1",
    sessionKey: chat.runtimeSessionKey,
    stream: "lifecycle",
    data: { phase: "end" },
  });
  assert.equal(goalWait(f.service.goals, chat), null);
  // Before it wrote anything, the Gateway's record reports it.
  background(
    f,
    () => false,
    () => true,
  );
  assert.equal(await backgroundRunning(f.service, chat.runtimeSessionKey), true);
});

test("a coding session the agent drives holds the nudge", async (t) => {
  const { f, chat } = setup(t);
  let holding = true;
  const store = new AssistantActionStore(f.store.db);
  const holdsGoal = (id) => holding && id === chat.id;
  f.assistants.workflows = { store, sessions: { holdsGoal }, async close() {} };
  await setGoal(f, chat);
  assert.equal(goalWait(f.service.goals, chat), "coding-session");
  await at(f, 0);
  await at(f, 2 * nudgeDelayMs);
  assert.equal(sends(f).length, 0);
  holding = false;
  assert.equal(goalWait(f.service.goals, chat), null);
});

test("a member's report to the main chat does not hold the nudge", async (t) => {
  // A colleague's answer for the lead holds it (assistant-work-goal-follow-ups.test.js).
  for (const body of [{ type: "report" }, { type: "report", fromMemberId: "m" }]) {
    const { f, agent, chat } = setup(t);
    await setGoal(f, chat);
    record(f, agent, chat, { kind: "lead-request", phase: "running", ...body });
    await round(f, chat, 0);
  }
});

test("a background command holds the nudge for at most two hours", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  background(f, () => true);
  await at(f, 0);
  await at(f, nudgeDelayMs);
  await at(f, backgroundWaitMs - 1);
  assert.equal(sends(f).length, 0);
  await at(f, backgroundWaitMs);
  await at(f, backgroundWaitMs + nudgeDelayMs - 1);
  assert.equal(sends(f).length, 0);
  await at(f, backgroundWaitMs + nudgeDelayMs);
  assert.equal(sends(f).length, 1);
});

test("three failed continuations block the goal as technical", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  for (let n = 0; n < 3; n++) {
    const { attempt } = await round(f, chat, n * 3 * nudgeDelayMs);
    f.complete(attempt.id, "error");
  }
  await at(f, 10 * nudgeDelayMs);
  const goal = goalOf(f, chat);
  assert.equal(goal.state, "blocked");
  assert.equal(goal.reasonCode, "technical");
  assert.equal(f.service.goals.notes(chat.id).at(-1).phase, "blocked");
  await at(f, 20 * nudgeDelayMs);
  assert.equal(sends(f).length, 3);
});

test("a refused continuation only waits; another error counts as failed", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  const send = f.assistants.send.bind(f.assistants);
  const refuse = (status) => {
    f.assistants.send = async () => {
      f.assistants.send = send;
      throw Object.assign(Error("refused"), { status });
    };
  };
  refuse(409);
  await at(f, 0);
  await at(f, nudgeDelayMs);
  assert.equal(goalOf(f, chat).failures, 0);
  assert.equal(goalOf(f, chat).nudges, 0);
  refuse(500);
  await at(f, 2 * nudgeDelayMs);
  await at(f, 3 * nudgeDelayMs);
  assert.equal(goalOf(f, chat).failures, 1);
  await round(f, chat, 4 * nudgeDelayMs);
  assert.equal(goalOf(f, chat).nudges, 1);
});

test("three continuations without a tool call block the goal as no progress", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  for (let n = 0; n < 3; n++) {
    const { attempt } = await round(f, chat, n * 3 * nudgeDelayMs);
    if (n === 1) {
      await at(f, n * 3 * nudgeDelayMs + nudgeDelayMs + 1);
      assert.equal(goalOf(f, chat).idleTurns, 1);
      f.service.goals.observe({
        runId: attempt.id,
        stream: "item",
        data: { kind: "tool" },
      });
    }
    f.complete(attempt.id);
    if (n === 1) {
      await at(f, n * 3 * nudgeDelayMs + nudgeDelayMs + 2);
      assert.equal(goalOf(f, chat).idleTurns, 0);
    }
  }
  // One round with a tool call between: two idle turns so far, not three.
  await at(f, 9 * nudgeDelayMs);
  assert.equal(goalOf(f, chat).state, "open");
  assert.equal(goalOf(f, chat).idleTurns, 1);
  for (let n = 3; n < 5; n++) {
    const { attempt } = await round(f, chat, n * 3 * nudgeDelayMs);
    f.complete(attempt.id);
  }
  await at(f, 20 * nudgeDelayMs);
  const goal = goalOf(f, chat);
  assert.equal(goal.state, "blocked");
  assert.equal(goal.reasonCode, "no-progress");
  assert.equal(sends(f).length, 5);
});

test("cancelling a continuation turn stops the goal", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  const entries = [];
  f.assistants.audit = { append: (entry) => entries.push(entry) };
  const { attempt } = await round(f, chat, 0);
  // The owner's stop control (POST /api/assistant-attempts/:id/cancel).
  f.service.goals.ownerCancel(attempt.id);
  f.assistants.ledger.transition(attempt.id, "cancelled");
  await at(f, 2 * nudgeDelayMs);
  const goal = goalOf(f, chat);
  assert.equal(goal.state, "stopped");
  assert.equal(goal.reasonCode, "turn-cancelled");
  assert.deepEqual(
    entries.map((e) => [e.details.change, e.source]),
    [
      ["continued", "system"],
      ["stopped", "user"],
    ],
  );
  await at(f, 5 * nudgeDelayMs);
  assert.equal(sends(f).length, 1);
});

test("the owner's newer message becomes the anchor", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  const b = turn(f, chat, owner, "Also the trailer");
  f.complete(b.attempt.id);
  const first = await round(f, chat, 0);
  assert.equal(
    f.service.store.context(first.request.id).goal.anchorRequestId,
    b.request.id,
  );
  assert.equal(goalOf(f, chat).anchorRequestId, b.request.id);
  f.complete(first.attempt.id);
  const c = turn(f, chat, { kind: "owner", forwarded: true }, "Forwarded");
  f.complete(c.attempt.id);
  const second = await round(f, chat, 3 * nudgeDelayMs);
  assert.equal(
    f.service.store.context(second.request.id).goal.anchorRequestId,
    b.request.id,
  );
});

test("a lost anchor blocks the goal instead of widening", async (t) => {
  const { f, chat } = setup(t);
  const { anchor } = await setGoal(f, chat);
  f.store.db
    .prepare("DELETE FROM assistant_team_records WHERE id=?")
    .run(`context:${anchor.id}`);
  await at(f, 0);
  await at(f, nudgeDelayMs);
  const goal = goalOf(f, chat);
  assert.equal(goal.state, "blocked");
  assert.equal(goal.reasonCode, "proof");
  assert.equal(sends(f).length, 0);
});

test("an archived chat or ineligible agent ends the goal visibly", async (t) => {
  const cases = [
    [
      "archived",
      (f, { chat }) => f.store.updateConversation(chat.id, { archivedAt: "x" }),
    ],
    [
      "ineligible",
      (f, { agent }) =>
        patchAgent(f, agent, {
          userAccess: { mode: "shared", members: [], released: [] },
        }),
    ],
    ["archived", (f, { agent }) => patchAgent(f, agent, { archivedAt: "x" })],
  ];
  for (const [reasonCode, change] of cases) {
    const { f, agent, chat } = setup(t);
    await setGoal(f, chat);
    change(f, { agent, chat });
    await at(f, 0);
    await at(f, nudgeDelayMs);
    const goal = goalOf(f, chat);
    assert.equal(goal.state, "ended", reasonCode);
    assert.equal(goal.reasonCode, reasonCode);
    assert.equal(f.service.goals.notes(chat.id).at(-1).phase, "ended");
    assert.equal(sends(f).length, 0);
  }
});

test("a deleted chat forgets its goal", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  f.store.updateConversation(chat.id, { deletedAt: "x" });
  await at(f, 0);
  assert.deepEqual(f.service.goals.store.list(chat.id), []);
});

test("a goal set from Telegram continues in the web chat only", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat, { kind: "telegram", channelId: "c", chatId: "1", userId: "2" });
  const { request: continuation } = await round(f, chat, 0);
  const ctx = f.service.store.context(continuation.id);
  assert.deepEqual(Object.keys(ctx).sort(), ["goal", "kind", "teamAllowed"]);
  assert.equal(ctx.kind, "owner");
  assert.equal(sends(f)[0].input.key, chat.runtimeSessionKey);
});

test("a continuation keeps the team permission of its anchor", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat, { kind: "owner", teamAllowed: true });
  const { request } = await round(f, chat, 0);
  assert.equal(f.service.store.context(request.id).teamAllowed, true);
});

test("settings save between continuation turns", async (t) => {
  const { f, agent, chat } = setup(t);
  await setGoal(f, chat);
  const { attempt } = await round(f, chat, 0);
  const revision = () => f.store.getAssistant(agent.id).revision;
  await assert.rejects(
    f.assistants.update(agent.id, { name: "X" }, revision()),
    (e) => e.key === "active",
  );
  f.complete(attempt.id);
  await at(f, 2 * nudgeDelayMs);
  const updated = await f.assistants.update(agent.id, { name: "X" }, revision());
  assert.equal(updated.name ?? f.store.getAssistant(agent.id).name, "X");
  assert.equal(sends(f).length, 1);
});

test("a restart keeps the goal and its anchor", async (t) => {
  const { f, chat } = setup(t);
  const { goal, anchor } = await setGoal(f, chat);
  const first = await round(f, chat, 0);
  f.complete(first.attempt.id);
  // The second continuation ends unseen by the process that sent it.
  const { attempt } = await round(f, chat, 3 * nudgeDelayMs);
  assert.equal(goalOf(f, chat).idleTurns, 1);
  f.complete(attempt.id);
  let now = 0;
  const store = new AssistantStore({ dataDir: f.dataDir });
  const a = f.assistants;
  const assistants = new AssistantService({
    store,
    runtime: a.runtime,
    config: a.config,
    models: a.models,
  });
  clearInterval(assistants.poll);
  const service = new TeamService({ assistants, autoStart: false, now: () => now });
  assistants.teams = service;
  t.after(async () => {
    await service.close();
    await assistants.close();
  });
  const open = service.goals.store.open(chat.id);
  assert.equal(open.id, goal.id);
  assert.equal(open.anchorRequestId, anchor.id);
  await service.goals.tick();
  // A turn this process did not send counts as progress.
  assert.equal(service.goals.store.open(chat.id).idleTurns, 0);
  assert.equal(service.goals.store.open(chat.id).evaluatedAttemptId, attempt.id);
  now = nudgeDelayMs;
  await service.goals.tick();
  assert.equal(sends(f).length, 3);
  const request = assistants.ledger.latestRequest(chat.id);
  assert.equal(service.store.context(request.id).goal.anchorRequestId, anchor.id);
  assert.equal(request.clientRequestId, `goal-continuation:${goal.id}:3`);
});

test("a Stop while the pass waits on the Gateway sends nothing", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  await at(f, 0);
  let answer;
  const client = f.assistants.runtime.client,
    call = client.call;
  client.call = (method, input) =>
    method === backgroundMethod
      ? new Promise((resolve) => (answer = resolve))
      : call(method, input);
  f.clock(nudgeDelayMs);
  const pass = f.service.goals.tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.service.goals.stop(chat.id);
  answer({ complete: true, running: 0 });
  await pass;
  assert.equal(goalOf(f, chat).state, "stopped");
  assert.equal(sends(f).length, 0);
});

test("the Gateway is asked about background commands only once the delay is over", async (t) => {
  const { f, chat } = setup(t);
  await setGoal(f, chat);
  let asked = 0;
  background(f, () => (asked++, false));
  await at(f, 0);
  await at(f, nudgeDelayMs - 1);
  assert.equal(asked, 0);
  await at(f, nudgeDelayMs);
  assert.equal(asked, 1);
  assert.equal(sends(f).length, 1);
});
