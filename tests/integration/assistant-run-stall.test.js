import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import {
  guardStalledRuns,
  stallAbortMs,
} from "../../server/features/assistants/run-stall-guard.js";
import { reconcileRuns } from "../../server/features/assistants/run-reconciler.js";

const key = "agent:news:main";

// An AssistantService on a fake Gateway with one chat and a running turn "run-1".
function service(t, { wait = { status: "error", error: "x" } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-run-stall-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const assistant = store.createAssistant({
    name: "News",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: key,
  });
  const calls = [];
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method, params) => {
    calls.push([method, params]);
    return method === "agent.wait" ? wait : {};
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.close = async () => {};
  let now = 1_000_000;
  const value = new AssistantService({
    store,
    runtime,
    now: () => now,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  value.reconcile = async () => {};
  t.after(() => value.close());
  const request = value.ledger.accept(chat.id, { clientRequestId: "c1", text: "Hi" });
  const attempt = value.ledger.recordAttempt(request.id);
  value.ledger.transition(attempt.id, "accepted", { runtimeRunId: "run-1" });
  const emit = (stream, data) =>
    client.emit("event", {
      event: "agent",
      payload: { runId: "run-1", sessionKey: key, stream, data },
    });
  return {
    service: value,
    calls,
    attempt,
    emit,
    client,
    advance: (ms) => (now += ms),
  };
}

test("a turn silent while it waits for the model is aborted and fails as stalled", async (t) => {
  const { service: s, calls, attempt, emit, advance } = service(t);
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs - 1000);
  await guardStalledRuns(s);
  assert.equal(calls.length, 0, "not yet");
  advance(1000);
  await guardStalledRuns(s);
  assert.deepEqual(calls, [["sessions.abort", { key, runId: "run-1" }]]);
  const ended = s.ledger.getAttempt(attempt.id);
  assert.deepEqual([ended.state, ended.failure], ["failed", "stalled"]);
  assert.equal(s.runSteps.view("run-1"), null);
});

test("a running tool, an approval and a compaction are never stalled", async (t) => {
  for (const [stream, data] of [
    ["item", { itemId: "tool:1", kind: "tool", name: "exec", phase: "start" }],
    ["lifecycle", { phase: "waiting-approval" }],
    ["compaction", { phase: "start" }],
  ]) {
    const { service: s, calls, attempt, emit, advance } = service(t);
    emit(stream, data);
    advance(stallAbortMs * 4);
    await guardStalledRuns(s);
    assert.deepEqual(calls, [], stream);
    assert.equal(s.ledger.getAttempt(attempt.id).state, "accepted");
  }
});

test("any frame of the run counts as a sign of life", async (t) => {
  const { service: s, calls, emit, advance } = service(t);
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs - 1000);
  emit("thinking", { delta: "..." });
  advance(stallAbortMs - 1000);
  await guardStalledRuns(s);
  assert.deepEqual(calls, []);
});

test("a run of no open turn is only forgotten", async (t) => {
  const { service: s, calls, attempt, emit, advance } = service(t);
  s.ledger.transition(attempt.id, "completed", {});
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs);
  await guardStalledRuns(s);
  assert.deepEqual(calls, []);
  assert.equal(s.runSteps.view("run-1"), null);
});

test("a run the model left unanswered fails with the reason timeout", async (t) => {
  const {
    service: s,
    attempt,
    client,
  } = service(t, {
    wait: { status: "error", error: "⚠️ The request took too long." },
  });
  // OpenClaw 2026.10.3's terminal frame of an idle model (assistant-run-steps-contract).
  client.emit("event", {
    event: "chat",
    payload: { runId: "run-1", sessionKey: key, state: "error", errorKind: "timeout" },
  });
  await reconcileRuns(s);
  const ended = s.ledger.getAttempt(attempt.id);
  assert.deepEqual([ended.state, ended.failure], ["failed", "timeout"]);
});

test("another failure keeps no reason", async (t) => {
  const { service: s, attempt } = service(t);
  await reconcileRuns(s);
  const ended = s.ledger.getAttempt(attempt.id);
  assert.deepEqual([ended.state, ended.failure], ["failed", undefined]);
});
