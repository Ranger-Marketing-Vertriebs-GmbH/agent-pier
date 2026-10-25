import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// A turn the Gateway refused before running it fails with the reason; an agent it
// did not admit is degraded until the Gateway restarts (AGENTPIER-238).
function setup(t, sendError) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-degraded-"));
  const store = new AssistantStore({ dataDir });
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: `agent:${assistant.runtimeAgentId}:test`,
  });
  const client = new EventEmitter();
  client.ready = true;
  client.sends = 0;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method) => {
    if (method === "sessions.send") {
      client.sends++;
      throw sendError(assistant);
    }
    if (method === "sessions.messages.subscribe") return {};
    if (method === "chat.history") return { messages: [], hasMore: false };
    if (method === "sessions.describe") return { session: {} };
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "agents.list") return { agents: [{ id: assistant.runtimeAgentId }] };
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
  const warn = console.warn;
  const warnings = [];
  console.warn = (line) => warnings.push(line);
  t.after(() => {
    console.warn = warn;
    service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { service, client, assistant, conversation, warnings };
}
const answered = (code, extra) =>
  Object.assign(Error("refused"), { code, status: 503, answered: true, ...extra });

test("a turn to an agent the Gateway did not admit fails and the agent shows degraded", async (t) => {
  const { service, client, assistant, conversation, warnings } = setup(t, (a) =>
    answered("UNAVAILABLE", {
      retryable: false,
      admissionRefusal: {
        agentId: a.runtimeAgentId,
        code: "agent-database-inspection-failed",
      },
    }),
  );
  const sent = await service.send(conversation.id, {
    clientRequestId: "one",
    text: "Private dinner plans",
  });
  assert.equal(sent.attempt.state, "failed");
  assert.equal(sent.attempt.failure, "degraded");
  assert.equal(sent.request.state, "failed");
  const evidence = JSON.parse(
    service.store.db
      .prepare("SELECT evidence FROM attempts WHERE id=?")
      .get(sent.attempt.id).evidence,
  );
  assert.deepEqual(evidence, { failure: "degraded", code: "UNAVAILABLE" });
  // Logged with its code, never the message text.
  assert.match(warnings.join(), /refused a turn \(UNAVAILABLE, degraded\)/);
  assert.doesNotMatch(warnings.join(), /dinner/);
  const list = service.list();
  assert.equal(list.assistants.find((a) => a.id === assistant.id).degraded, true);
  assert.equal(
    list.conversations.find((c) => c.id === conversation.id).diagnostic,
    "AGENT_DEGRADED",
  );
  assert.equal(list.activity[assistant.id].label, "status.degraded");
  // The next turn is refused before anything reaches the Gateway.
  await assert.rejects(
    service.send(conversation.id, { clientRequestId: "two", text: "Again" }),
    (error) => error.status === 503 && error.key === "agentDegraded",
  );
  assert.equal(client.sends, 1);
});

test("an explicit refusal fails the turn; a timeout or a lost connection stays open", async (t) => {
  const cases = [
    [answered("UNAVAILABLE", { retryable: false }), "failed", { failure: "refused" }],
    [
      Object.assign(Error("timeout"), { code: "TIMEOUT" }),
      "uncertain",
      { unconfirmed: "send", code: "TIMEOUT" },
    ],
    [Object.assign(Error("closed"), { code: "UNAVAILABLE" }), "uncertain", {}],
    [answered("UNAVAILABLE"), "uncertain", {}],
  ];
  for (const [error, state, expected] of cases) {
    const { service, conversation } = setup(t, () => error);
    const sent = await service.send(conversation.id, {
      clientRequestId: "x",
      text: "Hi",
    });
    assert.equal(sent.attempt.state, state);
    const evidence = JSON.parse(
      service.store.db
        .prepare("SELECT evidence FROM attempts WHERE id=?")
        .get(sent.attempt.id).evidence,
    );
    for (const [key, value] of Object.entries(expected))
      assert.equal(evidence[key], value);
    assert.equal(evidence.code, error.code);
    assert.equal(service.list().assistants[0].degraded, undefined);
  }
});
