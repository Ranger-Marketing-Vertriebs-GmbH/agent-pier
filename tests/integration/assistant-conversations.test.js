import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";

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
    ledger: { requests: () => [] },
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
