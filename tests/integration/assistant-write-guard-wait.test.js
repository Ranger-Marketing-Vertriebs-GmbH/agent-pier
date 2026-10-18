import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { writeGuardWiring } from "../../server/features/assistants/write-guard-wait.js";

// A ready 2026.10.3 Gateway whose plugin has not reported its write guard yet
// (WRITE_GUARD_PENDING), wired to the service exactly as assistant-graph.js does.
async function pendingGuardService(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-guard-wait-"));
  const store = new AssistantStore({ dataDir });
  let assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  assistant = store.updateAssistant(
    assistant.id,
    { capabilities: { memory: true, reminders: false } },
    assistant.revision,
  );
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "agent:home:test",
  });
  const state = { applies: [], sends: [], warnings: [] };
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method, params) => {
    if (method === "sessions.send") {
      state.sends.push(params.message);
      return { runId: `run-${state.sends.length}` };
    }
    if (method === "sessions.messages.subscribe") return {};
    if (method === "chat.history") return { messages: [], hasMore: false };
    if (method === "sessions.describe") return { session: {} };
    if (method === "agent.wait") return { status: "timeout" };
    assert.fail(method);
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.child = { pid: process.pid };
  runtime.status = () => ({ availability: "ready", version: "2026.10.3" });
  runtime.close = async () => {};
  runtime.setState = () => {};
  const config = { reset() {} };
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config,
  });
  service.warn = (line) => state.warnings.push(line);
  service.writeGuardPollMs = 10;
  const bridge = new TeamBridge({
    assistants: service,
    teams: { store: { context: () => ({ kind: "owner" }) } },
  });
  await bridge.start();
  Object.assign(config, writeGuardWiring({ bridge, nativeReady: () => true }), {
    apply: async () => {
      state.applies.push({ guardLive: bridge.guardLive() });
      await state.onApply?.();
    },
  });
  t.after(async () => {
    await bridge.close();
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const report = () => bridge.registerGuard({ pid: process.pid, ppid: process.ppid });
  const notes = async () =>
    (await service.history(conversation.id)).messages.filter(
      (m) => m.event === "memory-note",
    );
  const send = (clientRequestId, context, text = "Remember: router 10.0.0.1") =>
    service.send(conversation.id, { clientRequestId, text }, context);
  const complete = (sent) => service.ledger.transition(sent.attempt.id, "completed");
  return { service, bridge, state, report, notes, send, complete };
}

// Whether a step waited for the guard is told by a poll too long for any test: a
// step that waited would never settle within the bound, however busy the host.
async function withoutWait(f, step) {
  const poll = f.service.writeGuardPollMs;
  f.service.writeGuardPollMs = 10 * 60 * 1000;
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("no further wait")), 15000);
  });
  try {
    return await Promise.race([step(), bound]);
  } finally {
    clearTimeout(timer);
    f.service.writeGuardPollMs = poll;
  }
}

test("an owner turn waits for the write guard before it is applied and sent", async (t) => {
  const f = await pendingGuardService(t);
  assert.equal(
    f.service.config.writeGuardPending(f.service.store.listAssistants()[0]),
    true,
  );
  setTimeout(f.report, 100);
  const sent = await f.send("after-guard");
  assert.equal(sent.attempt.state, "accepted");
  assert.equal("readOnly" in sent, false);
  assert.deepEqual(f.state.applies, [{ guardLive: true }], "applied with writes");
  assert.equal(f.state.sends.length, 1);
  assert.deepEqual(await f.notes(), []);
  assert.deepEqual(f.state.warnings, []);
});

test("the wait ends with the window after readiness; later turns do not wait", async (t) => {
  const f = await pendingGuardService(t);
  // Ready long enough ago that 100 ms of the window remain.
  f.bridge.readyAt = Date.now() - 19900;
  const first = await f.send("guard-late");
  assert.equal(first.attempt.state, "accepted", "the turn is still delivered");
  assert.deepEqual(f.state.applies, [{ guardLive: false }]);
  const [note, ...rest] = await f.notes();
  assert.deepEqual(rest, []);
  assert.equal(note.reason, "guard-pending");
  assert.equal(f.state.warnings.length, 1, "the missing guard is logged");
  // A retry of the same request neither waits again nor adds a second note.
  f.complete(first);
  await f.send("guard-late");
  assert.equal(f.state.sends.length, 1);
  assert.equal((await f.notes()).length, 1);
  // The window is over: the next turn is sent at once, read-only and noted.
  f.complete(await withoutWait(f, () => f.send("after-window")));
  assert.equal((await f.notes()).length, 2);
  assert.equal(f.state.warnings.length, 1, "logged once per readiness");
  // Telegram's own chat is an owner turn too; forwarded content gets no note.
  f.complete(await f.send("telegram", { kind: "telegram", channelId: "c" }));
  assert.equal((await f.notes()).length, 3);
  f.complete(await f.send("forwarded", { kind: "telegram", forwarded: true }));
  assert.equal((await f.notes()).length, 3);
  assert.equal(f.state.sends.length, 4);
});

test("a Telegram turn waits like a web turn, and an invalid request never waits", async (t) => {
  const f = await pendingGuardService(t);
  setTimeout(f.report, 100);
  await f.send("telegram-wait", { kind: "telegram", channelId: "c" });
  assert.deepEqual(f.state.applies, [{ guardLive: true }]);
  await withoutWait(f, async () => {
    await assert.rejects(f.send("x".repeat(101)), { status: 400 });
    await assert.rejects(
      f.service.send("missing", { clientRequestId: "bad", text: "x", extra: 1 }),
      { status: 400 },
    );
  });
});

test("a guard that reports during the apply leaves no read-only note", async (t) => {
  const f = await pendingGuardService(t);
  f.bridge.readyAt = Date.now() - 20000;
  f.state.onApply = f.report;
  await f.send("reported-in-apply");
  assert.deepEqual(f.state.applies, [{ guardLive: false }]);
  assert.deepEqual(await f.notes(), [], "the turn ran with writes after all");
});

test("waiting web turns of one conversation are admitted in their order", async (t) => {
  const f = await pendingGuardService(t);
  const first = f.send("first", undefined, "First");
  const second = f.send("second", undefined, "Second");
  setTimeout(f.report, 60);
  assert.equal((await first).attempt.state, "accepted");
  // The second waits behind the first and then finds it still running.
  await assert.rejects(second, { status: 409 });
  assert.deepEqual(f.state.sends, ["First"]);
});
