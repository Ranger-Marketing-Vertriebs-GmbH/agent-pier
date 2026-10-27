import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { sessionScope } from "../../server/features/chat/chat-delivery.js";

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected the call to fail");
};

// A session the agent started in the project folder itself.
async function started(f) {
  const r = await f.call(await f.invocation(), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "codex",
    worktree: false,
  });
  assert.equal(r.state, "running");
  return r.sessionId;
}

// A fake clock on the facade: every sleep moves it forward and runs `onSleep`.
function fakeClock(f, onSleep = () => {}) {
  const clock = { at: Date.parse("2026-10-27T10:00:00Z"), sleeps: [] };
  const sessions = f.workflows.sessions;
  sessions.now = () => clock.at;
  sessions.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.at += ms;
    await onSleep(clock);
  };
  return clock;
}

// Activity readings in order; the last one repeats.
function readings(f, states) {
  const seen = [];
  f.services.activity = {
    async read(session) {
      seen.push(session.id);
      const state = states.length > 1 ? states.shift() : states[0];
      return { state, source: "fixture" };
    },
  };
  return seen;
}

const uuidOf = (key) => {
  const hex = createHash("sha256").update(key).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

test("send goes through chat delivery and a retry with the same requestId sends once", async (t) => {
  const f = await agentSessionFixture(t);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const sessionId = await started(f);
  const clock = fakeClock(f);
  const input = {
    action: "send",
    sessionId,
    text: "Fix the login page",
    requestId: "m1",
  };
  const first = await f.call(await f.invocation(), input);
  const again = await f.call(await f.invocation(), input);
  const deliveryId = uuidOf(`${f.id}:${sessionId}:m1`);
  assert.deepEqual(first, { deliveryId, status: "handed-off" });
  assert.deepEqual(again, first);
  const delivery = f.services.chatDelivery;
  assert.equal(delivery.receipts.size, 1);
  assert.equal(delivery.sent.length, 1);
  const session = await f.services.sessions.get(sessionId);
  assert.deepEqual(delivery.sent[0], {
    sessionId,
    body: {
      deliveryId,
      deliveryScope: sessionScope(session),
      text: "Fix the login page",
      submit: true,
    },
  });
  const record = f.workflows.sessions.store.get(sessionId);
  assert.equal(record.lastSentAt, clock.at);
  assert.deepEqual(record.seen, { state: "working", at: clock.at });
  // Without a requestId the tool call decides: a new call is a new message.
  const inv = await f.invocation();
  const a = await f.call(inv, { action: "send", sessionId, text: "Next" });
  const b = await f.call(inv, { action: "send", sessionId, text: "Next" });
  assert.equal(a.deliveryId, b.deliveryId);
  assert.equal(
    a.deliveryId,
    uuidOf(`${f.id}:${sessionId}:${inv.attemptId}:${inv.toolCallId}`),
  );
  assert.equal(delivery.sent.length, 2);
  // Audited with ids and enums only.
  const sent = events.filter((e) => e.action === "session.sent");
  assert.equal(sent.length, 4);
  assert.equal(sent[0].sessionId, sessionId);
  assert.deepEqual(sent[0].details.agentSession, {
    assistantId: f.id,
    op: "send",
    requestId: "m1",
    deliveryId,
    status: "handed-off",
  });
  assert.equal(JSON.stringify(events).includes("login page"), false);
});

test("send of text over 32000 characters is INVALID_INPUT", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  const send = async (text) =>
    code(f.call(await f.invocation(), { action: "send", sessionId, text }));
  assert.equal(await send("x".repeat(32001)), "INVALID_INPUT");
  assert.equal(await send(""), "INVALID_INPUT");
  assert.equal(await send(42), "INVALID_INPUT");
  assert.equal(f.services.chatDelivery.sent.length, 0);
  assert.equal(f.workflows.sessions.store.get(sessionId).lastSentAt ?? null, null);
  // The owner's session (no record of this agent) is never confirmed to exist.
  assert.equal(
    await code(
      f.call(await f.invocation(), { action: "send", sessionId: "other", text: "hi" }),
    ),
    "NOT_FOUND",
  );
});

test("a send while a prompt is pending is held, not refused", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, { id: "p1", kind: "permission" });
  f.services.chatDelivery.send = async (_id, body) => ({
    deliveryId: body.deliveryId,
    status: "pending",
    reason: "CHAT_PERMISSION_PENDING",
    waiting: "request",
    error: "Owner-facing German text",
  });
  const r = await f.call(await f.invocation(), {
    action: "send",
    sessionId,
    text: "Continue",
    requestId: "held",
  });
  assert.deepEqual(r, {
    deliveryId: uuidOf(`${f.id}:${sessionId}:held`),
    status: "pending",
    reason: "CHAT_PERMISSION_PENDING",
  });
});

test("read returns the newest replies after the cursor within the bounds", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  const messages = [];
  for (let i = 1; i <= 12; i++) {
    messages.push({ id: `u${i}`, role: "user", text: `question ${i}` });
    messages.push({
      id: `r${i}`,
      role: "assistant",
      status: "complete",
      text: `reply ${i}`,
    });
  }
  messages.push({ id: "failed", role: "assistant", status: "failed", text: "broken" });
  messages.push({ id: "empty", role: "assistant", text: "  " });
  f.setReplies(sessionId, messages);
  f.setActivity(sessionId, "idle");
  f.addRequest(sessionId, { id: "p1", kind: "question" });
  const read = async (input = {}) =>
    f.call(await f.invocation(), { action: "read", sessionId, ...input });

  const newest = await read();
  assert.deepEqual(
    newest.replies.map((r) => r.id),
    ["r10", "r11", "r12"],
  );
  assert.deepEqual(newest.replies[2], { id: "r12", text: "reply 12", truncated: false });
  assert.equal(newest.cursor, "r12");
  assert.equal(newest.pendingPrompts, 1);
  assert.equal(newest.state, "idle");
  assert.equal(f.workflows.sessions.store.get(sessionId).seen.state, "idle");

  const after = await read({ after: "r5", limit: 10 });
  assert.deepEqual(
    after.replies.map((r) => r.id),
    ["r6", "r7", "r8", "r9", "r10", "r11", "r12"],
  );
  const most = await read({ limit: 10 });
  assert.deepEqual(
    most.replies.map((r) => r.id),
    ["r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12"],
  );
  const none = await read({ after: "r12" });
  assert.deepEqual(none.replies, []);
  assert.equal(none.cursor, "r12");
  assert.equal(await code(read({ limit: 11 })), "INVALID_INPUT");
  assert.equal(await code(read({ limit: 0 })), "INVALID_INPUT");

  // Each reply is cut to 8000 characters, all of them to 24000.
  const long = (id) => ({ id, role: "assistant", text: id.repeat(4500) });
  f.setReplies(sessionId, [long("a1"), long("a2"), long("a3"), long("a4")]);
  f.setActivity(sessionId, "working");
  const cut = await read({ limit: 10 });
  assert.deepEqual(
    cut.replies.map((r) => [r.id, r.text.length, r.truncated]),
    [
      ["a2", 8000, true],
      ["a3", 8000, true],
      ["a4", 8000, true],
    ],
  );
  assert.equal(cut.state, "working");
  f.setReplies(sessionId, [
    { id: "b1", role: "assistant", text: "x".repeat(7000) },
    { id: "b2", role: "assistant", text: "y".repeat(7000) },
    { id: "b3", role: "assistant", text: "z".repeat(7000) },
    { id: "b4", role: "assistant", text: "w".repeat(7000) },
  ]);
  const budget = await read({ limit: 10 });
  assert.deepEqual(
    budget.replies.map((r) => [r.id, r.text.length, r.truncated]),
    [
      ["b1", 3000, true],
      ["b2", 7000, false],
      ["b3", 7000, false],
      ["b4", 7000, false],
    ],
  );
});

test("wait returns idle only after the turn started or 5 s passed", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  const clock = fakeClock(f);
  const wait = async (input = {}) =>
    f.call(await f.invocation(), { action: "wait", sessionId, ...input });
  // Without a send an idle session is idle right away.
  readings(f, ["idle"]);
  assert.deepEqual(await wait(), { state: "idle", reason: "idle", pendingPrompts: 0 });
  assert.equal(clock.sleeps.length, 0);

  await f.call(await f.invocation(), { action: "send", sessionId, text: "Go" });
  const seen = readings(f, ["idle", "idle", "working", "idle"]);
  const begin = clock.at;
  assert.deepEqual(await wait(), { state: "idle", reason: "idle", pendingPrompts: 0 });
  assert.equal(seen.length, 4);
  assert.equal(clock.at - begin, 3000);
  assert.ok(clock.sleeps.every((ms) => ms === 1000));
  assert.deepEqual(f.workflows.sessions.store.get(sessionId).seen, {
    state: "idle",
    at: clock.at,
  });

  // A turn that never shows as working counts as done 5 s after the send.
  await f.call(await f.invocation(), { action: "send", sessionId, text: "Again" });
  const sentAt = clock.at;
  const idle = readings(f, ["idle"]);
  assert.deepEqual(await wait(), { state: "idle", reason: "idle", pendingPrompts: 0 });
  assert.equal(clock.at - sentAt, 5000);
  assert.equal(idle.length, 6);
  assert.equal(f.workflows.sessions.waiting.size, 0);
});

test("wait returns waiting when a prompt opens and ended when the session stops", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  fakeClock(f);
  const wait = async () =>
    f.call(await f.invocation(), { action: "wait", sessionId, timeoutSeconds: 10 });
  await f.call(await f.invocation(), { action: "send", sessionId, text: "Go" });
  f.addRequest(sessionId, { id: "p1", kind: "permission" });
  readings(f, ["unknown", "working", "waiting"]);
  assert.deepEqual(await wait(), {
    state: "waiting",
    reason: "waiting",
    pendingPrompts: 1,
  });
  assert.equal(f.workflows.sessions.store.get(sessionId).seen.state, "waiting");
  readings(f, ["working", "stopped"]);
  assert.deepEqual(await wait(), { state: "ended", reason: "ended", pendingPrompts: 1 });
  assert.equal(f.workflows.sessions.store.get(sessionId).seen.state, "ended");
});

test("wait returns state working with reason timeout after timeoutSeconds", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  const during = [],
    admitted = [];
  // A wait never holds the agents' admission lock (one at a time, like
  // AssistantService admit, which the workflow fixture replaces): other calls run
  // meanwhile.
  let lock = Promise.resolve();
  f.workflows.a.admit = (operation) => (lock = lock.catch(() => {}).then(operation));
  const clock = fakeClock(f, async () => {
    during.push(f.workflows.sessions.waiting.has(sessionId));
    let ran = false;
    f.workflows.a.admit(() => (ran = true));
    await new Promise((resolve) => setImmediate(resolve));
    admitted.push(ran);
  });
  const seen = readings(f, ["working"]);
  const begin = clock.at;
  const r = await f.call(await f.invocation(), {
    action: "wait",
    sessionId,
    timeoutSeconds: 3,
  });
  assert.deepEqual(r, { state: "working", reason: "timeout", pendingPrompts: 0 });
  assert.equal(clock.at - begin, 3000);
  assert.equal(seen.length, 4);
  assert.deepEqual(during, [true, true, true]);
  assert.deepEqual(admitted, [true, true, true]);
  assert.equal(f.workflows.sessions.waiting.has(sessionId), false);
  // The default is 60 s; the bounds are 1-100.
  readings(f, ["working"]);
  const start = clock.at;
  await f.call(await f.invocation(), { action: "wait", sessionId });
  assert.equal(clock.at - start, 60000);
  for (const timeoutSeconds of [0, 101, 1.5, "5"])
    assert.equal(
      await code(
        f.call(await f.invocation(), { action: "wait", sessionId, timeoutSeconds }),
      ),
      "INVALID_INPUT",
    );
});

test("wait on a session the owner deleted answers NOT_FOUND", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  readings(f, ["working"]);
  // Deleted while the agent waits: the next poll answers NOT_FOUND.
  fakeClock(f, (clock) => {
    if (clock.sleeps.length === 2) f.sessions.delete(sessionId);
  });
  assert.equal(
    await code(
      f.call(await f.invocation(), { action: "wait", sessionId, timeoutSeconds: 10 }),
    ),
    "NOT_FOUND",
  );
  assert.equal(f.workflows.sessions.waiting.size, 0);
  // Gone before the call as well.
  assert.equal(
    await code(f.call(await f.invocation(), { action: "wait", sessionId })),
    "NOT_FOUND",
  );
  assert.equal(
    await code(f.call(await f.invocation(), { action: "read", sessionId })),
    "NOT_FOUND",
  );
});
