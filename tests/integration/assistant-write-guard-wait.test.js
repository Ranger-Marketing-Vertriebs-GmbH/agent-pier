import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// A ready Gateway whose plugin has not reported its write guard yet
// (WRITE_GUARD_PENDING): `pending` says so, `applies` records each turn's apply.
function pendingGuardService(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-guard-wait-"));
  const store = new AssistantStore({ dataDir });
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "agent:home:test",
  });
  const state = { pending: true, applies: [], sends: 0 };
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method) => {
    if (method === "sessions.send") return { runId: `run-${++state.sends}` };
    if (method === "sessions.messages.subscribe") return {};
    if (method === "chat.history") return { messages: [], hasMore: false };
    if (method === "sessions.describe") return { session: {} };
    if (method === "agent.wait") return { status: "timeout" };
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
    config: {
      apply: async () => state.applies.push({ guardPending: state.pending }),
      reset() {},
      writeGuardPending: (profile) => {
        assert.equal(profile.id, assistant.id);
        return state.pending;
      },
    },
  });
  t.after(async () => {
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const notes = async () =>
    (await service.history(conversation.id)).messages.filter(
      (m) => m.event === "memory-note",
    );
  return { service, conversation, state, notes };
}

test("an owner turn waits for the write guard before it is applied and sent", async (t) => {
  const f = pendingGuardService(t);
  setTimeout(() => (f.state.pending = false), 150);
  const sent = await f.service.send(f.conversation.id, {
    clientRequestId: "after-guard",
    text: "Remember my router is 10.0.0.1",
  });
  assert.equal(sent.attempt.state, "accepted");
  assert.deepEqual(f.state.applies, [{ guardPending: false }], "applied with writes");
  assert.equal(f.state.sends, 1);
  assert.deepEqual(await f.notes(), []);
});

test("a turn the guard does not reach in time runs read-only and says so in the chat", async (t) => {
  const f = pendingGuardService(t);
  f.service.writeGuardWaitMs = 100;
  const sent = await f.service.send(f.conversation.id, {
    clientRequestId: "guard-late",
    text: "Remember my router is 10.0.0.1",
  });
  assert.equal(sent.attempt.state, "accepted", "the turn is still delivered");
  assert.deepEqual(f.state.applies, [{ guardPending: true }]);
  const [note, ...rest] = await f.notes();
  assert.deepEqual(rest, []);
  assert.equal(note.role, "event");
  assert.equal(note.reason, "guard-pending");
  assert.equal(typeof note.timestamp, "number");
  // A retry of the same request neither waits again nor adds a second note.
  f.service.ledger.transition(sent.attempt.id, "completed");
  await f.service.send(f.conversation.id, {
    clientRequestId: "guard-late",
    text: "Remember my router is 10.0.0.1",
  });
  assert.equal(f.state.sends, 1);
  assert.equal((await f.notes()).length, 1);
  // Forwarded content never writes memory, so it gets no note either.
  await f.service.send(
    f.conversation.id,
    { clientRequestId: "forwarded", text: "Forwarded mail" },
    { kind: "telegram", forwarded: true },
  );
  assert.equal(f.state.sends, 2);
  assert.equal((await f.notes()).length, 1);
});
