import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// Gateway `agent` frames as OpenClaw 2026.10.3 sends them around a compaction
// (assistant-compaction-contract.test.js), and the marker chat.history serves after it.
const key = "agent:news:main";
const agent = (stream, runId, data, sessionKey = key) => ({
  event: "agent",
  payload: { stream, runId, sessionKey, data },
});
const status = (phase, runId = "run-1", sessionKey) =>
  agent("run_status", runId, { phase }, sessionKey);

function gatewayClient(pages) {
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method) => (method === "chat.history" ? pages() : {});
  return client;
}

function compactingService(t, { now = () => Date.now() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-compaction-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const assistant = store.createAssistant({
    name: "News",
    model: { connectionId: "c", modelId: "m" },
  });
  const news = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: key,
  });
  const history = { messages: [] };
  const runtime = new EventEmitter();
  runtime.client = gatewayClient(() => history);
  runtime.close = async () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
    now,
  });
  service.reconcile = async () => {};
  t.after(() => service.close());
  const changes = [];
  service.events.subscribe((e) => {
    if (e.type === "change") changes.push(e);
  });
  const emit = (frame) => runtime.client.emit("event", frame);
  // An owner turn the Gateway runs as `runId`, as sendMessage records it.
  const send = (runId) => {
    const request = service.ledger.accept(news.id, {
      clientRequestId: crypto.randomUUID(),
      text: `Turn ${runId}`,
    });
    const attempt = service.ledger.recordAttempt(request.id);
    return service.ledger.transition(attempt.id, "accepted", { runtimeRunId: runId });
  };
  const done = (attempt, state = "completed") =>
    service.ledger.transition(attempt.id, state);
  return { service, store, runtime, news: news.id, history, changes, emit, send, done };
}

test("the history says while a run flushes memory and compacts before it answers", async (t) => {
  const f = compactingService(t);
  f.send("run-1");
  assert.equal((await f.service.history(f.news)).compacting, false);
  f.emit(status("memory_flushing"));
  assert.equal(f.changes.length, 1, "the clients refresh once");
  assert.equal((await f.service.history(f.news)).compacting, true);
  // The flush ends right before the compaction model call: still summarising.
  f.emit(status("preparing_context"));
  assert.equal(f.changes.length, 1, "no refresh while the summary goes on");
  assert.equal((await f.service.history(f.news)).compacting, true);
  // The run itself starts.
  f.emit(status("preparing_workspace"));
  f.emit(status("starting_model"));
  assert.equal(f.changes.length, 2);
  assert.equal((await f.service.history(f.news)).compacting, false);
});

test("a compaction inside a run shows until it ends, a retry keeps it", async (t) => {
  const f = compactingService(t);
  const first = f.send("run-1");
  f.emit(agent("lifecycle", "run-1", { phase: "start" }));
  f.emit(agent("compaction", "run-1", { phase: "start" }));
  assert.equal((await f.service.history(f.news)).compacting, true);
  f.emit(
    agent("compaction", "run-1", { phase: "end", completed: true, willRetry: true }),
  );
  assert.equal((await f.service.history(f.news)).compacting, true);
  f.emit(agent("compaction", "run-1", { phase: "end", completed: true }));
  assert.equal((await f.service.history(f.news)).compacting, false);
  // A run that fails during its compaction ends the status too.
  f.done(first);
  f.send("run-2");
  f.emit(agent("compaction", "run-2", { phase: "start" }));
  f.emit(agent("lifecycle", "run-2", { phase: "error" }));
  assert.equal((await f.service.history(f.news)).compacting, false);
  assert.equal(f.changes.length, 4);
});

test("other sessions and a reconnect leave no summary status behind", async (t) => {
  const f = compactingService(t);
  f.emit(status("memory_flushing", "run-9", "agent:unknown:main"));
  assert.equal(f.changes.length, 0, "an unknown session refreshes nothing");
  f.send("run-1");
  f.emit(status("memory_flushing"));
  assert.equal((await f.service.history(f.news)).compacting, true);
  f.service.bindGateway();
  assert.equal((await f.service.history(f.news)).compacting, false);
});

test("a run cancelled while it flushed leaves no status for the next turn", async (t) => {
  const f = compactingService(t);
  const flushing = f.send("run-1");
  f.emit(status("memory_flushing"));
  assert.equal((await f.service.history(f.news)).compacting, true);
  // The run dies; its end never reaches AgentPier.
  f.done(flushing, "cancelled");
  assert.equal((await f.service.history(f.news)).compacting, false);
  f.send("run-2");
  assert.equal(
    (await f.service.history(f.news)).compacting,
    false,
    "the next turn is not summarising before it says so",
  );
  // It does say so: its own flush shows.
  f.emit(status("memory_flushing", "run-2"));
  assert.equal((await f.service.history(f.news)).compacting, true);
});

test("a summary status whose end never arrives expires", async (t) => {
  let now = 1000;
  const f = compactingService(t, { now: () => now });
  f.send("run-1");
  f.emit(status("memory_flushing"));
  assert.equal((await f.service.history(f.news)).compacting, true);
  now += 61 * 60000;
  assert.equal((await f.service.history(f.news)).compacting, false);
});

test("a finished compaction stays as a note where it happened, also from the cache", async (t) => {
  const f = compactingService(t);
  f.history.messages = [
    { role: "user", content: "Hi", timestamp: 10, __openclaw: { id: "u1" } },
    { role: "assistant", content: "Hello", timestamp: 11, __openclaw: { id: "a1" } },
    {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      timestamp: 12,
      __openclaw: {
        kind: "compaction",
        id: "c1",
        tokensBefore: 251400,
        tokensAfter: 18200,
      },
    },
    { role: "user", content: "Next", timestamp: 13, __openclaw: { id: "u2" } },
    { role: "assistant", content: "Sure", timestamp: 14, __openclaw: { id: "a2" } },
  ];
  const note = {
    id: "compaction:c1",
    role: "event",
    event: "compaction",
    tokensBefore: 251400,
    tokensAfter: 18200,
    timestamp: 12,
    runId: null,
  };
  const live = await f.service.history(f.news);
  assert.deepEqual(
    live.messages.map((m) => m.id),
    ["u1", "a1", "compaction:c1", "u2", "a2"],
  );
  assert.deepEqual(live.messages[2], note);
  // Readers of replies (Telegram, team results) look for assistant turns only.
  assert.deepEqual(
    live.messages.filter((m) => m.role === "assistant").map((m) => m.id),
    ["a1", "a2"],
  );
  f.runtime.client.ready = false;
  const cached = await f.service.history(f.news);
  assert.equal(cached.stale, true);
  assert.deepEqual(
    cached.messages.find((m) => m.event === "compaction"),
    note,
  );
});
