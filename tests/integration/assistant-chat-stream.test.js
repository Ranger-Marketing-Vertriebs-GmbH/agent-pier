import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// Frames shaped like OpenClaw 2026.9.8 `chat` events: the first delta of a run on a
// connection is a snapshot (`message` holds the reply so far), later ones carry only
// the appended `deltaText`; `replace: true` restarts the text.
const snapshot = (sessionKey, runId, text) => ({
  event: "chat",
  payload: {
    runId,
    sessionKey,
    state: "delta",
    deltaText: text,
    message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 },
  },
});
const append = (sessionKey, runId, deltaText, extra = {}) => ({
  event: "chat",
  payload: { runId, sessionKey, state: "delta", deltaText, ...extra },
});
const final = (sessionKey, runId) => ({
  event: "chat",
  payload: { runId, sessionKey, state: "final" },
});

function gatewayClient() {
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async () => ({});
  return client;
}

function streamingService(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-chat-stream-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const assistant = store.createAssistant({
    name: "News",
    model: { connectionId: "c", modelId: "m" },
  });
  const news = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "agent:news:main",
  });
  const other = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "agent:news:other",
  });
  const runtime = new EventEmitter();
  runtime.client = gatewayClient();
  runtime.close = async () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  service.reconcile = async () => {};
  t.after(() => service.close());
  const published = [];
  service.events.subscribe((e) => {
    if (e.type === "delta") published.push([e.conversationId, e.runId, e.text]);
  });
  const emit = (frame) => runtime.client.emit("event", frame);
  return { service, runtime, news: news.id, other: other.id, published, emit };
}

test("streamed chat deltas add up to the reply so far", async (t) => {
  const { emit, published, news } = streamingService(t);
  emit(snapshot("agent:news:main", "run-1", "Noch"));
  emit(append("agent:news:main", "run-1", " keine"));
  emit(append("agent:news:main", "run-1", " neuen Meldungen."));
  assert.deepEqual(
    published.map(([, , text]) => text),
    ["Noch", "Noch keine", "Noch keine neuen Meldungen."],
  );
  assert.ok(published.every(([id, runId]) => id === news && runId === "run-1"));
});

test("a replace frame restarts the text and later appends build on it", async (t) => {
  const { emit, published } = streamingService(t);
  emit(snapshot("agent:news:main", "run-1", "Draft"));
  emit(append("agent:news:main", "run-1", "Rewritten", { replace: true }));
  emit(append("agent:news:main", "run-1", " reply"));
  assert.deepEqual(
    published.map(([, , text]) => text),
    ["Draft", "Rewritten", "Rewritten reply"],
  );
});

test("parallel conversations keep their own streamed text", async (t) => {
  const { emit, published, news, other } = streamingService(t);
  emit(snapshot("agent:news:main", "run-1", "One"));
  emit(snapshot("agent:news:other", "run-2", "Two"));
  emit(append("agent:news:main", "run-1", " more"));
  emit(append("agent:news:other", "run-2", " more"));
  assert.deepEqual(published, [
    [news, "run-1", "One"],
    [other, "run-2", "Two"],
    [news, "run-1", "One more"],
    [other, "run-2", "Two more"],
  ]);
});

test("an append without the run's snapshot is never shown as the whole reply", async (t) => {
  const { emit, published } = streamingService(t);
  emit(snapshot("agent:news:main", "run-1", "Old reply"));
  emit(final("agent:news:main", "run-1"));
  // A new run must not build on the finished one, and a fragment alone is not a reply.
  emit(append("agent:news:main", "run-2", "fragment"));
  emit(snapshot("agent:news:main", "run-2", "New reply"));
  emit(append("agent:news:main", "run-2", " grows"));
  assert.deepEqual(
    published.map(([, runId, text]) => [runId, text]),
    [
      ["run-1", "Old reply"],
      ["run-2", "New reply"],
      ["run-2", "New reply grows"],
    ],
  );
});

test("a reconnected Gateway resumes a run mid-stream from its snapshot", async (t) => {
  const { emit, published, runtime } = streamingService(t);
  emit(snapshot("agent:news:main", "run-1", "Before"));
  runtime.client = gatewayClient();
  runtime.emit("status", { availability: "ready" });
  // The new connection has no receipt, so the Gateway sends a full snapshot first.
  emit(snapshot("agent:news:main", "run-1", "Before and during"));
  emit(append("agent:news:main", "run-1", " and after"));
  assert.deepEqual(
    published.map(([, , text]) => text),
    ["Before", "Before and during", "Before and during and after"],
  );
});
