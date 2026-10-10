import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
function runtimeFixture({ historyFails = false } = {}) {
  const runtime = new EventEmitter();
  runtime.client = {
    ready: true,
    subscribe: () => () => {},
    call: async (method) => {
      if (method === "sessions.send") return { runId: "accepted-run" };
      if (method === "agent.wait") return { status: "timeout" };
      if (method === "sessions.describe") return { session: {} };
      if (method === "chat.history") {
        if (historyFails) throw Error("unavailable");
        return { messages: [] };
      }
      return {};
    },
  };
  runtime.close = async () => {};
  runtime.setState = (state) => {
    runtime.state = state;
  };
  return runtime;
}
function serviceFor(dataDir, runtime) {
  return new AssistantService({
    store: new AssistantStore({ dataDir }),
    runtime,
    models: {},
    config: { apply: async () => {} },
  });
}
for (const graceful of [true, false])
  test(`accepted work remains recoverable after ${graceful ? "graceful shutdown" : "abrupt application loss"}`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-app-recovery-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const first = serviceFor(dataDir, runtimeFixture());
    const a = first.store.createAssistant({
      name: "Home",
      model: { connectionId: "c", modelId: "m" },
    });
    const c = first.store.saveConversation({
      assistantId: a.id,
      runtimeSessionKey: "session",
    });
    const sent = await first.send(c.id, { clientRequestId: "one", text: "Hello" });
    assert.equal(sent.attempt.state, "accepted");
    if (graceful) await first.close();
    else {
      clearInterval(first.poll);
      first.closed = true;
      first.store.close();
    }
    const resumed = serviceFor(dataDir, runtimeFixture());
    t.after(() => resumed.close());
    await resumed.reconcile();
    assert.equal(resumed.ledger.getAttempt(sent.attempt.id).state, "uncertain");
    assert.equal(resumed.ledger.requests(c.id).length, 1);
  });
test("a ready Gateway with stale history cannot report current synchronization", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-sync-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = runtimeFixture({ historyFails: true });
  const service = serviceFor(dataDir, runtime);
  t.after(() => service.close());
  const a = service.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  service.store.saveConversation({ assistantId: a.id, runtimeSessionKey: "session" });
  await service.reconcile();
  assert.equal(runtime.state.sync, "stale");
});
