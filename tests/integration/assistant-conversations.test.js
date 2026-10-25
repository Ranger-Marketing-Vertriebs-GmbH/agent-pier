import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
} from "../helpers/agent-hook-fixture.js";

test("maintenance history serves cached messages and fences late responses across resume", async (t) => {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "assistant-history-maintenance-"),
  );
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const assistant = store.createAssistant({
    name: "History",
    model: { connectionId: "c", modelId: "m" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "session",
  });
  store.cacheMessages(conversation.id, [
    { id: "saved", role: "assistant", text: "Saved", timestamp: 1 },
  ]);
  let finish,
    calls = 0;
  const service = {
    store,
    maintenance: false,
    maintenanceEpoch: 0,
    runtime: {
      client: {
        ready: true,
        call: () => {
          calls++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    },
    ledger: { requests: () => [], attemptRequests: () => new Map() },
  };
  const pending = conversationHistory(service, conversation.id);
  service.maintenance = true;
  service.maintenanceEpoch++;
  const cachedPromise = conversationHistory(service, conversation.id);
  assert.equal(calls, 1);
  const cached = await cachedPromise;
  assert.equal(cached.stale, true);
  assert.equal(cached.messages[0].text, "Saved");
  service.maintenance = false;
  finish({ messages: [{ role: "assistant", content: "Old response", timestamp: 2 }] });
  assert.equal((await pending).stale, true);
  assert.deepEqual(
    store.messages(conversation.id).map((m) => m.text),
    ["Saved"],
  );
});

test("lost acceptance never replays a send and timeout never means completion", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-send-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "agent:home:test",
  });
  let sends = 0,
    waitResult = { status: "timeout" };
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method) => {
    if (method === "sessions.send") {
      sends++;
      throw Error("connection dropped after acceptance");
    }
    if (method === "sessions.messages.subscribe") return {};
    if (method === "chat.history") return { messages: [], hasMore: false };
    if (method === "sessions.describe") return { session: {} };
    if (method === "agent.wait") return waitResult;
    assert.fail(method);
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.close = async () => {};
  runtime.setState = () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  t.after(() => service.close());
  const input = { clientRequestId: "delivery", text: "Dinner ideas" };
  const first = await service.send(conversation.id, input);
  assert.equal(first.attempt.state, "uncertain");
  const again = await service.send(conversation.id, input);
  assert.equal(again.request.id, first.request.id);
  assert.equal(sends, 1);
  await service.reconcile();
  assert.equal(service.ledger.getAttempt(first.attempt.id).state, "uncertain");
  waitResult = { status: "ok", terminalReceipt: { runId: first.attempt.id }, endedAt: 1 };
  await service.reconcile();
  assert.equal(service.ledger.getAttempt(first.attempt.id).state, "completed");
  assert.equal(sends, 1);
  assert.equal((await service.history(conversation.id)).requests.length, 1);
});

test("runtime timeout is nonterminal, cancellation is distinct and duplicate history collapses by native identity", async () => {
  const { terminalState } =
    await import("../../server/features/assistants/run-reconciler.js");
  const { publicMessages } =
    await import("../../server/features/assistants/conversations.js");
  assert.equal(terminalState({ status: "timeout" }), null);
  assert.equal(terminalState({ status: "ok", stopReason: "rpc" }), "cancelled");
  assert.equal(terminalState({ status: "error" }), "failed");
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Reply" }],
    timestamp: 10,
    __openclaw: { id: "stable" },
  };
  assert.deepEqual(publicMessages([message, message]), [
    { id: "stable", role: "assistant", text: "Reply", timestamp: 10, runId: null },
  ]);
});
test("an exec completion's user entry is never served as an owner message", async () => {
  // OpenClaw 2026.10.7's chat.history shows the completion turn's user entry (10.3
  // hid it): only its reply is the chat's.
  const { publicMessages } =
    await import("../../server/features/assistants/conversations.js");
  const messages = [
    {
      role: "user",
      content: "Render it.",
      provenance: { kind: "external_user" },
      timestamp: 1,
      __openclaw: { id: "owner" },
    },
    {
      role: "user",
      content: "Exec completed (salty-sh, code 0) :: RENDERED",
      provenance: { kind: "internal_system", sourceTool: "exec" },
      timestamp: 2,
      __openclaw: { id: "completion", senderIsOwner: false },
    },
    // Any other session event of OpenClaw's (a task's completion) stays hidden too.
    {
      role: "user",
      content: "Task finished: render-batch",
      provenance: { kind: "internal_system", sourceTool: "task" },
      timestamp: 2,
      __openclaw: { id: "task", senderIsOwner: false },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Saved." }],
      timestamp: 3,
      __openclaw: { id: "reply", runId: "turn-1" },
    },
  ];
  assert.deepEqual(
    publicMessages(messages).map((m) => [m.id, m.role, m.text]),
    [
      ["owner", "user", "Render it."],
      ["reply", "assistant", "Saved."],
    ],
  );
});

test("recovery blocks new dispatch until the owned process exits and preserves uncertainty", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-recover-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "session" });
  const runtime = new EventEmitter();
  let stopped = false,
    releaseStop;
  runtime.client = {
    ready: true,
    subscribe: () => () => {},
    call: async () => {
      throw Error("must not dispatch during recovery");
    },
  };
  runtime.stop = () =>
    new Promise((r) => {
      releaseStop = () => {
        stopped = true;
        r();
      };
    });
  runtime.start = async () => assert.ok(stopped);
  runtime.close = async () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: {},
    config: { apply: async () => {} },
  });
  t.after(() => service.close());
  const req = service.ledger.accept(c.id, { clientRequestId: "original", text: "Hello" });
  const attempt = service.ledger.recordAttempt(req.id);
  service.ledger.transition(attempt.id, "uncertain");
  const recovery = service.recover(attempt.id, { acknowledgeUnknownOutcome: true });
  assert.throws(() => service.requireReady(), { status: 503 });
  releaseStop();
  await recovery;
  assert.equal(service.ledger.getAttempt(attempt.id).state, "uncertain");
  assert.ok(service.ledger.getAttempt(attempt.id).reviewedAt);
  assert.equal(service.ledger.pending().length, 0);
});

test("a Gateway restart during maintenance moves event subscriptions to the new client", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-maintenance-rebind-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const gatewayClient = () => {
    const client = new EventEmitter();
    client.ready = true;
    client.subscribe = (f) => {
      client.on("event", f);
      return () => client.off("event", f);
    };
    client.call = async () => ({});
    return client;
  };
  const runtime = new EventEmitter();
  runtime.client = gatewayClient();
  runtime.close = async () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  t.after(() => service.close());
  const seen = [];
  service.gatewayEvents.on("exec.approval.requested", (p) => seen.push(p.id));
  const old = runtime.client;
  service.maintenance = true;
  runtime.client = gatewayClient();
  runtime.emit("status", { availability: "ready" });
  service.maintenance = false;
  old.emit("event", { event: "exec.approval.requested", payload: { id: "old" } });
  runtime.client.emit("event", {
    event: "exec.approval.requested",
    payload: { id: "new" },
  });
  assert.deepEqual(seen, ["new"]);
  assert.equal(
    runtime.client.listenerCount("event"),
    2,
    "conversation and hub listeners",
  );
  assert.equal(old.listenerCount("event"), 0);
});

test("Gateway chat frames feed the conversation's live feed instead of an SSE delta", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-feed-wiring-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const a = store.createAssistant({
    name: "Feed",
    model: { connectionId: "c", modelId: "m" },
  });
  const c = store.saveConversation({ assistantId: a.id, runtimeSessionKey: "feed-key" });
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method) =>
    method === "chat.history" ? { messages: [], hasMore: false } : {};
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.close = async () => {};
  runtime.setState = () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  t.after(() => service.close());
  const published = [];
  service.events.subscribe((event) => published.push(event));
  const chat = (payload) =>
    client.emit("event", {
      event: "chat",
      payload: { sessionKey: "feed-key", runId: "run", ...payload },
    });
  chat({ state: "delta", message: { role: "assistant", content: "Hel" } });
  const frames = [];
  const unsubscribe = service.feeds.subscribe(c.id, {}, (f) => frames.push(f));
  t.after(unsubscribe);
  chat({ state: "delta", deltaText: "lo" });
  assert.deepEqual(
    frames.filter((f) => f.type === "stream"),
    [
      { type: "stream", runId: "run", from: 0, text: "Hel" },
      { type: "stream", runId: "run", from: 3, text: "lo" },
    ],
  );
  // The reply streams only through the feed now.
  assert.equal(
    published.some((e) => e.type === "delta"),
    false,
  );
  chat({ state: "final" });
  assert.equal(service.feeds.entries.get(c.id).runs.size, 0);
  // A scoped change still announces the list change.
  published.length = 0;
  service.changed({ conversationId: c.id });
  assert.deepEqual(published, [{ type: "change" }]);
});

// The hook fixture's agent with a Gateway serving `page()` as its main chat's history.
async function eventChat(t, page = () => []) {
  const f = hookFixture(t);
  const main = f.reminders.mainConversation(f.id);
  const service = {
    store: f.store,
    ledger: f.assistants.ledger,
    routines: f.routines,
    runtime: {
      generation: 1,
      client: {
        ready: true,
        call: async (method, input) => {
          assert.equal(method, "chat.history");
          return { messages: input.sessionKey === main.runtimeSessionKey ? page() : [] };
        },
      },
    },
  };
  return {
    f,
    main,
    service,
    history: (id = main.id) => conversationHistory(service, id),
  };
}
const turn = (role, text, timestamp, id) => ({
  role,
  content: [{ type: "text", text }],
  timestamp,
  __openclaw: { id },
});

test("the main chat's view carries the event area, other chats none", async (t) => {
  const now = Date.now();
  const { f, main, service, history } = await eventChat(t, () => [
    turn("assistant", "Lentil soup today.", now + 1, "m-routine"),
    turn("user", "Thanks", now + 3, "m-user"),
  ]);
  const record = (entry) =>
    f.routines.results.record({
      conversationId: main.id,
      runAtMs: 0,
      status: "ok",
      ...entry,
    });
  record({
    id: "r",
    name: "Meal plan",
    at: now - 30,
    text: "Lentil soup today.",
    committed: true,
  });
  record({
    id: "c",
    kind: "heartbeat",
    name: "",
    at: now - 20,
    text: "All quiet.\nNothing new.",
    committed: false,
  });
  record({
    id: "m",
    kind: "reminder",
    name: "Call",
    at: now - 10,
    text: "Call mum.",
    committed: false,
  });
  await f.hooks.deliver(makeHook(f), body('{"id":"p1"}'));
  const view = await history();
  assert.deepEqual(
    view.events.map((e) => [e.id.split(":")[0], e.source, e.status]),
    [
      ["hook", "hook", "running"],
      ["routine", "checkin", "done"],
      ["routine", "routine", "done"],
    ],
  );
  assert.equal(view.events[1].firstLine, "All quiet.");
  assert.equal(view.events[2].name, "Meal plan");
  // The routine's committed reply and the check-in leave the transcript; the
  // reminder (kept with its text) and the owner's message stay.
  assert.deepEqual(
    view.messages.map((m) => [m.role, m.text, m.scheduled?.kind ?? null]),
    [
      ["assistant", "Call mum.", "reminder"],
      ["user", "Thanks", null],
    ],
  );
  const other = f.store.saveConversation({
    assistantId: f.id,
    runtimeSessionKey: "other-session",
  });
  assert.notEqual(other.id, main.id);
  assert.deepEqual((await conversationHistory(service, other.id)).events, []);
});

test("a hook event in the area shows status, duplicates and first line, not the payload", async (t) => {
  let prompt = null;
  const { f, history } = await eventChat(t, () => [
    // Should OpenClaw ever show the run's prompt as a turn, it stays hidden.
    ...(prompt ? [turn("user", prompt, Date.now(), "m-prompt")] : []),
    turn("assistant", "Disk on db1 is full.\nThe log grew.", Date.now(), "m-reply"),
  ]);
  const hook = makeHook(f);
  const text = '{"id":"p1","note":"PAYLOAD_MARK <b>x</b>"}';
  await f.hooks.deliver(hook, body(text));
  await f.hooks.deliver(hook, body(text));
  const stored = event(f, hook, "p1");
  prompt = f.jobs.get(stored.jobId).payload.message;
  assert.ok(prompt.includes("PAYLOAD_MARK"));
  await f.hooks.runs.complete(
    stored.id,
    done(stored.jobId, { summary: "\n  Disk on db1 is full.\nThe log grew." }),
  );
  const view = await history();
  assert.deepEqual(view.events, [
    {
      id: `hook:${stored.id}`,
      source: "hook",
      name: "Zabbix",
      sender: "zabbix01",
      at: stored.receivedAt,
      status: "done",
      duplicates: 1,
      firstLine: "Disk on db1 is full.",
      reply: "Disk on db1 is full.\nThe log grew.",
      hookId: hook.id,
      eventId: stored.id,
    },
  ]);
  // Neither the reply OpenClaw committed nor the prompt with its payload is a message.
  assert.deepEqual(view.messages, []);
  assert.ok(!JSON.stringify(view).includes("PAYLOAD_MARK"));
});

test("the event detail returns the payload cut to 16 KiB as text", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  // 3-byte characters: 16384 is no character boundary, the cut moves before it.
  const text = JSON.stringify({ id: "big", note: `<b>x</b>${"€".repeat(6000)}` });
  await f.hooks.deliver(hook, body(text));
  const stored = event(f, hook, "big");
  f.assistants.workflows.get = (id) =>
    ({
      a1: { id: "a1", assistantId: f.id, state: "running", run: { url: "/old" } },
      other: { id: "other", assistantId: "someone-else", state: "running" },
    })[id];
  f.assistants.workflows.liveRun = (a) =>
    a.id === "a1" ? { run: { url: "http://127.0.0.1:4380/pipelines/runs/r1" } } : {};
  f.hooks.events.patch(stored.id, { coding: ["a1", "other", "gone"] });
  await f.hooks.runs.complete(stored.id, done(stored.jobId, { summary: "Looked." }));
  const detail = f.hooks.eventDetail(f.id, hook.id, stored.id);
  assert.equal(detail.payloadCut, true);
  assert.equal(typeof detail.payload, "string");
  assert.ok(Buffer.byteLength(detail.payload) <= 16384);
  assert.ok(Buffer.byteLength(detail.payload) > 16380);
  assert.ok(text.startsWith(detail.payload));
  assert.ok(detail.payload.includes("<b>x</b>"), "kept as literal text");
  assert.deepEqual(
    { ...detail, payload: undefined },
    {
      receivedAt: new Date(stored.receivedAt).toISOString(),
      size: Buffer.byteLength(text),
      contentType: "application/json",
      source: "local",
      payload: undefined,
      payloadCut: true,
      activity: [],
      coding: [
        {
          actionId: "a1",
          state: "running",
          runUrl: "http://127.0.0.1:4380/pipelines/runs/r1",
        },
      ],
      notified: { push: true, telegram: false },
      reply: "Looked.",
    },
  );
  // A small payload is whole; another hook's event or an unknown one is not found.
  await f.hooks.deliver(hook, body('{"id":"small"}'));
  const small = event(f, hook, "small");
  assert.deepEqual(
    [
      f.hooks.eventDetail(f.id, hook.id, small.id).payload,
      f.hooks.eventDetail(f.id, hook.id, small.id).payloadCut,
    ],
    ['{"id":"small"}', false],
  );
  const second = makeHook(f, { name: "Other" });
  for (const [hookId, id] of [
    [second.id, stored.id],
    [hook.id, "missing"],
    ["missing", stored.id],
  ])
    assert.throws(() => f.hooks.eventDetail(f.id, hookId, id), { status: 404 });
});
