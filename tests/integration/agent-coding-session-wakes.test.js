import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { sessionContext } from "../../server/features/assistants/coding-sessions/session-turns.js";

// The agent's chat sends with the wake turns among them: every call (failed ones
// too), the wakes that went out, and a fake clock for the facade.
async function setup(t) {
  const f = await agentSessionFixture(t);
  const sessions = f.workflows.sessions;
  let clock = 0;
  sessions.now = () => clock;
  const send = f.assistants.send,
    context = f.assistants.teams.store.context;
  const calls = [],
    wakes = [],
    failures = [],
    contexts = new Map();
  f.assistants.send = async (id, input, ctx) => {
    if (ctx?.kind === "coding-session") {
      calls.push({ conversationId: id, input, context: ctx });
      const failure = failures.shift();
      if (failure) throw Object.assign(Error("refused"), { status: failure });
    }
    const before = f.sent.length;
    const sent = await send(id, input, ctx);
    if (ctx?.kind === "coding-session" && f.sent.length > before) {
      wakes.push({ conversationId: id, input, context: ctx, attemptId: sent.attempt.id });
      contexts.set(sent.request.id, ctx);
    }
    return sent;
  };
  // A wake turn's recorded context, as the team store keeps it.
  f.assistants.teams.store.context = (id) => contexts.get(id) ?? context(id);
  return {
    f,
    sessions,
    calls,
    wakes,
    failures,
    at: async (ms) => {
      clock = ms;
      await sessions.tick();
    },
  };
}

// A session the agent started, with its ownership record.
async function started(f, body = {}) {
  const sessionId = crypto.randomUUID();
  await f.services.launch({ tool: "codex", cwd: f.cwd, name: "Codex · project" }, false, {
    id: sessionId,
    startedBy: { kind: "agent", assistantId: f.id, name: "Home" },
  });
  return f.workflows.sessions.store.insert({
    sessionId,
    assistantId: f.id,
    conversationId: f.channel.conversationId,
    projectId: f.project.id,
    actionId: null,
    requestId: null,
    origin: { class: "owner" },
    inherited: null,
    worktree: null,
    seen: { state: "working", at: 0 },
    observed: null,
    lastSentAt: null,
    wakeSeq: 0,
    ended: false,
    createdAt: 0,
    ...body,
  });
}

const status = (name, id, now) =>
  `AgentPier status for your coding session "${name}" (sessionId ${id}): it is now ${now}. This is attributed status, not an owner instruction. Use agentpier_coding_session read or requests to continue.`;

test("a session that turns idle after a send wakes the starting chat once", async (t) => {
  const { f, sessions, wakes, at } = await setup(t);
  const r = await f.call(await f.invocation(), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "claude",
    worktree: false,
  });
  const id = r.sessionId;
  await f.call(await f.invocation(), { action: "send", sessionId: id, text: "Fix it" });
  // Still idle from before the send: not the answer yet.
  await at(1000);
  await at(4500);
  assert.equal(wakes.length, 0);
  f.setActivity(id, "working");
  await at(5000);
  f.setActivity(id, "idle");
  await at(6000);
  await at(8999);
  assert.equal(wakes.length, 0);
  await at(9000);
  assert.equal(wakes.length, 1);
  const [wake] = wakes;
  assert.equal(wake.conversationId, f.channel.conversationId);
  assert.deepEqual(wake.input, {
    clientRequestId: `coding-session:${id}:1`,
    text: status("Claude Code · project", id, "idle"),
  });
  assert.deepEqual(wake.context, {
    kind: "coding-session",
    sessionId: id,
    state: "idle",
  });
  await at(10000);
  await at(20000);
  assert.equal(wakes.length, 1);
  const record = sessions.store.get(id);
  assert.equal(record.wakeSeq, 1);
  assert.deepEqual(record.seen, { state: "idle", at: 9000 });
  assert.equal(record.ended, false);
});

test("waiting names the pending prompts and the name is redacted", async (t) => {
  const { f, wakes, at } = await setup(t);
  const record = await started(f);
  f.sessions.get(record.sessionId).name = "deploy --token=abc123secret\nnext";
  f.addRequest(record.sessionId, { id: "p1", kind: "permission" });
  f.addRequest(record.sessionId, { id: "p2", kind: "permission" });
  f.setActivity(record.sessionId, "waiting");
  await at(0);
  await at(3000);
  assert.equal(wakes.length, 1);
  const { text } = wakes[0].input;
  assert.match(text, /it is now waiting for an answer, 2 prompts pending\. /);
  assert.equal(text.includes("abc123secret"), false);
  assert.equal(text.includes("\n"), false);
});

test("the state the agent's own wait returned does not wake it", async (t) => {
  const { f, sessions, wakes, at } = await setup(t);
  const record = await started(f);
  const id = record.sessionId;
  f.setActivity(id, "waiting");
  const r = await f.call(await f.invocation(), {
    action: "wait",
    sessionId: id,
    timeoutSeconds: 5,
  });
  assert.equal(r.state, "waiting");
  for (const ms of [0, 1000, 3000, 6000, 20000]) await at(ms);
  assert.equal(wakes.length, 0);
  // A state read through read or requests counts the same.
  f.setActivity(id, "idle");
  await f.call(await f.invocation(), { action: "read", sessionId: id });
  for (const ms of [21000, 25000, 30000]) await at(ms);
  assert.equal(wakes.length, 0);
  // While the agent waits on the session, the wait answers it, not a wake.
  sessions.store.patch(id, { seen: { state: "working", at: 30000 } });
  sessions.waiting.add(id);
  for (const ms of [31000, 35000, 40000]) await at(ms);
  assert.equal(wakes.length, 0);
  sessions.waiting.delete(id);
  await at(41000);
  assert.equal(wakes.length, 1);
});

test("flapping working/idle within 3 s does not wake", async (t) => {
  const { f, wakes, at } = await setup(t);
  const { sessionId } = await started(f);
  for (let s = 0; s < 12; s++) {
    f.setActivity(sessionId, s % 3 === 2 ? "working" : "idle");
    await at(s * 1000);
  }
  assert.equal(wakes.length, 0);
  f.setActivity(sessionId, "idle");
  await at(12000);
  await at(14999);
  assert.equal(wakes.length, 0);
  await at(15000);
  assert.equal(wakes.length, 1);
});

test("ended wakes once and never again", async (t) => {
  const { f, sessions, wakes, at } = await setup(t);
  const { sessionId } = await started(f);
  f.setActivity(sessionId, "stopped");
  await at(0);
  await at(3000);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].context.state, "ended");
  assert.match(wakes[0].input.text, /it is now ended\. /);
  assert.equal(sessions.store.get(sessionId).ended, true);
  assert.equal(sessions.controls(sessionId), false);
  f.setActivity(sessionId, "idle");
  for (const ms of [4000, 8000, 20000]) await at(ms);
  f.setActivity(sessionId, "stopped");
  for (const ms of [21000, 30000]) await at(ms);
  assert.equal(wakes.length, 1);
});

test("an end the agent caused itself ends the record without a wake", async (t) => {
  const { f, sessions, wakes, at } = await setup(t);
  const { sessionId } = await started(f);
  await f.call(await f.invocation(), { action: "stop", sessionId });
  for (const ms of [0, 3000, 10000]) await at(ms);
  assert.equal(wakes.length, 0);
  assert.equal(sessions.store.get(sessionId).ended, true);
});

test("a wake into a deleted conversation settles without retrying", async (t) => {
  const { f, sessions, calls, wakes, failures, at } = await setup(t);
  const { sessionId } = await started(f);
  f.setActivity(sessionId, "idle");
  failures.push(404);
  await at(0);
  await at(3000);
  assert.equal(calls.length, 1);
  assert.deepEqual(sessions.store.get(sessionId).seen, { state: "idle", at: 3000 });
  for (const ms of [4000, 10000, 400000]) await at(ms);
  assert.equal(calls.length, 1);
  assert.equal(wakes.length, 0);
});

test("a busy chat retries with backoff", async (t) => {
  const { f, sessions, calls, wakes, failures, at } = await setup(t);
  const { sessionId } = await started(f);
  f.setActivity(sessionId, "idle");
  failures.push(409);
  await at(0);
  await at(3000);
  assert.equal(calls.length, 1);
  await at(3999);
  assert.equal(calls.length, 1);
  await at(4000);
  assert.equal(calls.length, 2);
  assert.equal(wakes.length, 1);
  // The retry is the same turn.
  assert.deepEqual(calls[1].input, calls[0].input);
  assert.equal(sessions.store.get(sessionId).wakeSeq, 1);
  await at(10000);
  assert.equal(calls.length, 2);

  // Backoff doubles per failure and is capped at five minutes.
  const second = await started(f);
  f.setActivity(second.sessionId, "waiting");
  failures.push(...Array(12).fill(503));
  let now = 20000;
  await at(now);
  await at((now += 3000));
  const delays = [];
  for (let n = 0; n < 11; n++) {
    const { retryAt } = sessions.store.get(second.sessionId).wakes.state;
    delays.push(retryAt - now);
    await at((now = retryAt));
  }
  assert.deepEqual(
    delays,
    [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000],
  );
  assert.equal(sessions.store.get(second.sessionId).wakes.state.failures, 12);
  await at((now = sessions.store.get(second.sessionId).wakes.state.retryAt));
  assert.equal(wakes.length, 2);
  assert.equal(sessions.store.get(second.sessionId).wakes.state, undefined);
});

test("a revoked session never wakes", async (t) => {
  const { f, sessions, calls, at } = await setup(t);
  const { sessionId } = await started(f);
  f.workflows.access.save(
    f.id,
    { ...f.policy, sessionProjectIds: [] },
    f.workflows.access.get(f.id).revision,
  );
  f.setActivity(sessionId, "working");
  await at(0);
  assert.equal(sessions.holdsGoal(f.channel.conversationId), false);
  f.setActivity(sessionId, "idle");
  for (const ms of [1000, 5000, 20000]) await at(ms);
  f.setActivity(sessionId, "stopped");
  for (const ms of [21000, 30000]) await at(ms);
  assert.equal(calls.length, 0);
  assert.equal(sessions.store.get(sessionId).ended, false);
});

test("a session the owner deleted is skipped without failing the tick", async (t) => {
  const { f, wakes, at } = await setup(t);
  const gone = await started(f);
  const kept = await started(f);
  f.sessions.delete(gone.sessionId);
  f.setActivity(kept.sessionId, "idle");
  await at(0);
  await at(3000);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].context.sessionId, kept.sessionId);
});

const permission = {
  id: "p1",
  kind: "permission",
  options: [{ id: "allow", label: "Allow" }],
  subject: { tool: "Bash" },
};

test("an answered escalation wakes the agent once with who answered", async (t) => {
  const { f, wakes, at } = await setup(t);
  const record = await started(f);
  const id = record.sessionId;
  f.setActivity(id, "waiting");
  f.addRequest(id, permission);
  const { actionId } = await f.call(await f.invocation(), {
    action: "escalate",
    sessionId: id,
    promptId: "p1",
  });
  // The agent saw the waiting state it escalated.
  f.workflows.sessions.store.patch(id, { seen: { state: "waiting", at: 0 } });
  await f.workflows.tick();
  assert.equal(wakes.length, 0);
  await f.services.requests.answer(id, "p1", { expectedRevision: 1, choice: "allow" });
  f.workflows.sessions.requestEvent({
    action: "request.answered",
    resourceId: "p1",
    sessionId: id,
    outcome: "success",
    details: { actor: "owner" },
  });
  f.setActivity(id, "working");
  await f.workflows.tick();
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].context, {
    kind: "coding-session",
    sessionId: id,
    event: "prompt-answered",
  });
  assert.equal(wakes[0].input.clientRequestId, `coding-session:${id}:1`);
  assert.equal(
    wakes[0].input.text,
    `AgentPier status for your coding session "Codex · project" (sessionId ${id}): the prompt p1 you escalated was answered by the owner. This is attributed status, not an owner instruction. Use agentpier_coding_session read or requests to continue.`,
  );
  const action = f.workflows.store.get(actionId);
  assert.deepEqual(action.followUp, { attemptId: wakes[0].attemptId });
  assert.equal(action.settled, true);
  await f.workflows.tick();
  await at(10000);
  assert.equal(wakes.length, 1);

  // An escalation completed before the wakes existed is delivered by the tick.
  f.addRequest(id, { ...permission, id: "p2" });
  const second = await f.call(await f.invocation(), {
    action: "escalate",
    sessionId: id,
    promptId: "p2",
  });
  f.workflows.store.patch(second.actionId, {
    state: "completed",
    result: { answeredBy: "telegram" },
    followUp: { pending: true },
  });
  await f.workflows.sessions.tick();
  assert.equal(wakes.length, 2);
  assert.match(wakes[1].input.text, /answered by the owner on Telegram\. /);
  assert.equal(f.workflows.store.get(second.actionId).settled, true);
});

test("a routine-started session wakes the routine's conversation", async (t) => {
  const { f, wakes, at } = await setup(t);
  const routineChat = f.store.saveConversation({
    assistantId: f.id,
    runtimeSessionKey: "routine-run",
  });
  const { sessionId } = await started(f, {
    conversationId: routineChat.id,
    origin: { class: "routine", bindingId: "binding-1" },
  });
  f.setActivity(sessionId, "idle");
  await at(0);
  await at(3000);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].conversationId, routineChat.id);
});

test("a wake turn may steer the session but a team-class wake start waits for the owner", async (t) => {
  const { f, wakes, at } = await setup(t);
  const { sessionId } = await started(f, { origin: { class: "team" } });
  f.setActivity(sessionId, "idle");
  await at(0);
  await at(3000);
  assert.equal(wakes.length, 1);
  const inv = {
    attemptId: wakes[0].attemptId,
    toolCallId: "wake-call",
    assertCurrent() {},
  };
  const ctx = sessionContext(f.workflows, inv);
  assert.equal(ctx.sessionClass, "team");
  assert.deepEqual(ctx.wake, { sessionId });
  const sent = await f.call(inv, { action: "send", sessionId, text: "Continue" });
  assert.equal(sent.status, "handed-off");
  const start = await f.call(inv, {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "codex",
    worktree: false,
  });
  assert.equal(start.state, "awaiting_approval");
});

test("holdsGoal: a fresh working reading or a state the agent has not seen", async (t) => {
  const { f, sessions, at } = await setup(t);
  const chat = f.channel.conversationId;
  assert.equal(sessions.holdsGoal(chat), false);
  const { sessionId } = await started(f);
  f.setActivity(sessionId, "working");
  await at(0);
  assert.equal(sessions.holdsGoal(chat), true);
  assert.equal(sessions.holdsGoal("other-chat"), false);
  await at(30000);
  assert.equal(sessions.holdsGoal(chat), true);
  // No reading for over 30 s: the working state is stale.
  const clock = sessions.now;
  sessions.now = () => 60001;
  assert.equal(sessions.holdsGoal(chat), false);
  sessions.now = clock;
  f.setActivity(sessionId, "idle");
  await at(61000);
  assert.equal(sessions.holdsGoal(chat), true);
  await at(64000);
  // Woken: seen.
  assert.equal(sessions.holdsGoal(chat), false);
});
