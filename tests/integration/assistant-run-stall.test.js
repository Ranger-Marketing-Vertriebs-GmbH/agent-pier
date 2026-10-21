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
import { bindChatEvents } from "../../server/features/assistants/gateway-wiring.js";

const key = "agent:news:main";

// An AssistantService on a fake Gateway with one chat and a running turn "run-1".
function service(t, { wait = { status: "error", error: "x" }, abort } = {}) {
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
    if (method === "sessions.abort" && abort) return abort(params);
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
    chat,
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

// Logs of the guard, kept out of the test output.
function quiet(t) {
  const logged = [];
  for (const level of ["warn", "error"])
    t.mock.method(console, level, (...args) => logged.push([level, args.join(" ")]));
  return logged;
}

test("a reply that ends the run during its abort keeps the turn", async (t) => {
  quiet(t);
  let fixture;
  fixture = service(t, {
    abort: async () => {
      fixture.client.emit("event", {
        event: "chat",
        payload: { runId: "run-1", sessionKey: key, state: "final" },
      });
      return {};
    },
  });
  const { service: s, attempt, emit, advance } = fixture;
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs);
  await guardStalledRuns(s);
  assert.equal(s.ledger.getAttempt(attempt.id).state, "accepted");
});

test("a run the reconciler settles during its abort still fails as stalled", async (t) => {
  quiet(t);
  let fixture;
  fixture = service(t, {
    wait: { status: "aborted" },
    abort: async () => {
      await reconcileRuns(fixture.service);
      return {};
    },
  });
  const { service: s, attempt, emit, advance } = fixture;
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs);
  await guardStalledRuns(s);
  const ended = s.ledger.getAttempt(attempt.id);
  assert.deepEqual([ended.state, ended.failure], ["failed", "stalled"]);
});

test("an aborted run of no stall is still cancelled", async (t) => {
  const { service: s, attempt } = service(t, { wait: { status: "aborted" } });
  await reconcileRuns(s);
  assert.equal(s.ledger.getAttempt(attempt.id).state, "cancelled");
});

test("a run not heard from since a reconnect is not judged", async (t) => {
  quiet(t);
  const { service: s, calls, emit, advance } = service(t);
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs);
  bindChatEvents(s);
  await guardStalledRuns(s);
  assert.deepEqual(calls, []);
  assert.ok(s.runSteps.view("run-1"), "its steps stay for the chat");
  emit("lifecycle", { phase: "model" });
  advance(stallAbortMs);
  await guardStalledRuns(s);
  assert.deepEqual(calls, [["sessions.abort", { key, runId: "run-1" }]]);
});

test("a run that speaks while an earlier one is aborted is spared", async (t) => {
  quiet(t);
  let fixture;
  fixture = service(t, {
    abort: async (params) => {
      if (params.runId === "run-1")
        fixture.client.emit("event", {
          event: "agent",
          payload: { runId: "run-2", sessionKey: "agent:news:other", stream: "thinking" },
        });
      return {};
    },
  });
  const { service: s, calls, emit, advance, client } = fixture;
  const other = s.store.saveConversation({
    assistantId: fixture.chat.assistantId,
    runtimeSessionKey: "agent:news:other",
  });
  const request = s.ledger.accept(other.id, { clientRequestId: "c2", text: "Hi" });
  const second = s.ledger.recordAttempt(request.id);
  s.ledger.transition(second.id, "accepted", { runtimeRunId: "run-2" });
  emit("lifecycle", { phase: "start" });
  client.emit("event", {
    event: "agent",
    payload: { runId: "run-2", sessionKey: "agent:news:other", stream: "lifecycle" },
  });
  advance(stallAbortMs);
  await guardStalledRuns(s);
  assert.deepEqual(
    calls.map(([, params]) => params.runId),
    ["run-1"],
  );
  assert.equal(s.ledger.getAttempt(second.id).state, "accepted");
});

test("the guard logs an abort and a failed one, without content", async (t) => {
  const logged = quiet(t);
  const {
    service: s,
    attempt,
    emit,
    advance,
  } = service(t, {
    abort: async () => {
      throw new Error("gateway timeout");
    },
  });
  emit("lifecycle", { phase: "start" });
  advance(stallAbortMs);
  await guardStalledRuns(s);
  assert.equal(s.ledger.getAttempt(attempt.id).state, "accepted");
  assert.equal(s.runFailures?.get("run-1"), undefined);
  assert.deepEqual(logged, [
    ["error", "Stalled agent turn of run run-1 not ended: gateway timeout"],
  ]);

  const ok = service(t);
  ok.emit("lifecycle", { phase: "start" });
  ok.advance(stallAbortMs);
  await guardStalledRuns(ok.service);
  assert.match(logged.at(-1)[1], new RegExp(`Agent turn ${ok.attempt.id} aborted`));
  assert.doesNotMatch(logged.at(-1)[1], /Hi/);
});
