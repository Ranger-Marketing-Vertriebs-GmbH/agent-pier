import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

// A Gateway that runs the turn but whose acknowledgement of sessions.send never
// arrives in time: the send times out, the run goes on.
// `dataDir` reopens an earlier fixture's data, as after an AgentPier restart.
async function setup(t, { dataDir, sendError = "TIMEOUT" } = {}) {
  const reopened = !!dataDir;
  if (!reopened) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-unconfirmed-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  }
  const store = new AssistantStore({ dataDir });
  const assistant = reopened
    ? store.listAssistants()[0]
    : store.createAssistant({ name: "Home", model: { connectionId: "c", modelId: "m" } });
  const conversation = reopened
    ? store.listConversations()[0]
    : store.saveConversation({
        assistantId: assistant.id,
        runtimeSessionKey: "agent:home:unconfirmed",
      });
  const gateway = {
    sendOptions: null,
    wait: { status: "timeout" },
    transcript: [],
  };
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method, _params, options) => {
    if (method === "sessions.send") {
      gateway.sendOptions = options;
      throw Object.assign(Error("RPC failed"), { code: sendError });
    }
    if (method === "sessions.messages.subscribe") return {};
    if (method === "chat.history")
      return { messages: gateway.transcript, hasMore: false };
    if (method === "sessions.describe") return { session: {} };
    if (method === "agent.wait") return gateway.wait;
    assert.fail(method);
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  // The bridge's counter starts at 1 in every process; the launch id never repeats
  // in a real supervisor, here it does on purpose.
  runtime.generation = 1;
  runtime.generationId = "launch-1";
  runtime.close = async () => {};
  runtime.setState = () => {};
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  t.after(() => (service.closed ? undefined : service.close()));
  const bridge = new TeamBridge({
    assistants: service,
    teams: {},
    generation: () => runtime.generation,
  });
  await bridge.start();
  t.after(() => bridge.close());
  // Whether the Gateway's plugin gets a ticket for an AgentPier tool of this session.
  const tool = (action) => {
    try {
      bridge.prepare({
        agentId: store.getAssistant(assistant.id).runtimeAgentId,
        sessionKey: conversation.runtimeSessionKey,
        toolCallId: randomUUID(),
        action,
      });
      return true;
    } catch (error) {
      assert.equal(error.status, 403);
      return false;
    }
  };
  const emit = (runId, event = "agent") =>
    client.emit("event", {
      event,
      payload: {
        sessionKey: conversation.runtimeSessionKey,
        runId,
        stream: "lifecycle",
        data: { phase: "start" },
      },
    });
  const send = (text = "Lass uns weiter machen") =>
    service.send(conversation.id, { clientRequestId: randomUUID(), text });
  return { dataDir, store, service, runtime, conversation, gateway, tool, emit, send };
}

test("a send whose acknowledgement timed out stays confirmable", async (t) => {
  const f = await setup(t);
  const { attempt } = await f.send();
  // The admission lock is not held longer than the client's default timeout.
  assert.equal(f.gateway.sendOptions?.timeoutMs, undefined);
  assert.equal(attempt.state, "uncertain");
  assert.equal(attempt.unconfirmed, true);
  // The sidebar counts it as working, not as needing attention.
  assert.deepEqual(
    f.service.ledger.latestByConversation().map((r) => r.attemptState),
    ["unconfirmed"],
  );
  assert.deepEqual(f.service.list().activity[f.conversation.assistantId], {
    state: "working",
    reason: "attempt",
    label: "status.unconfirmed",
    pendingApprovals: 0,
    team: null,
  });
  // Without proof the turn has no AgentPier tools.
  assert.equal(f.tool("workspace"), false);
  assert.equal(f.tool("share_file"), false);
  await f.service.reconcile();
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
});

test("a Gateway event of the turn's run confirms it, its tools work and it completes", async (t) => {
  const f = await setup(t);
  const { attempt } = await f.send();
  f.emit(randomUUID());
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
  f.emit(attempt.id);
  const confirmed = f.service.ledger.getAttempt(attempt.id);
  assert.equal(confirmed.state, "running");
  assert.equal(confirmed.unconfirmed, undefined);
  assert.equal(f.tool("workspace"), true);
  assert.equal(f.tool("share_file"), true);
  f.gateway.wait = { status: "ok", runId: attempt.id, endedAt: 1 };
  await f.service.reconcile();
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "completed");
});

test("the turn's own message in the transcript confirms it", async (t) => {
  const f = await setup(t);
  const { attempt } = await f.send("Dann lass uns weiter machen");
  await f.service.reconcile();
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
  // Another turn's message proves nothing.
  f.gateway.transcript.push({
    role: "user",
    content: "Earlier",
    timestamp: 1,
    __openclaw: { id: "m0", idempotencyKey: `${randomUUID()}:user` },
  });
  await f.service.reconcile();
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
  f.gateway.transcript.push({
    role: "user",
    content: "Dann lass uns weiter machen",
    timestamp: 2,
    __openclaw: { id: "m1", idempotencyKey: `${attempt.id}:user` },
  });
  await f.service.reconcile();
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "running");
  assert.equal(f.tool("workspace"), true);
});

test("no proof confirms a turn after a restart, a review or a lost run", async (t) => {
  const f = await setup(t);
  const { attempt } = await f.send();
  // A restarted Gateway ended whatever ran; its events belong to new runs.
  f.runtime.generation = 2;
  f.runtime.generationId = "launch-2";
  f.emit(attempt.id);
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
  assert.equal(f.tool("workspace"), false);
  f.runtime.generation = 1;
  f.runtime.generationId = "launch-1";
  f.service.ledger.review(attempt.id);
  f.emit(attempt.id);
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
  // An attempt made uncertain by a restart (not by a lost send) is never confirmed.
  const other = f.service.ledger.accept(f.conversation.id, {
    clientRequestId: "restart",
    text: "Hello",
  });
  const lost = f.service.ledger.recordAttempt(other.id);
  f.service.ledger.transition(lost.id, "accepted", { runtimeRunId: lost.id });
  f.service.markOutstandingUnknown();
  assert.equal(f.service.ledger.getAttempt(lost.id).unconfirmed, undefined);
  f.emit(lost.id);
  assert.equal(f.service.ledger.getAttempt(lost.id).state, "uncertain");
  assert.equal(f.tool("workspace"), false);
});

test("a send the closed connection refused at once is not confirmable", async (t) => {
  const f = await setup(t, { sendError: "CLOSED" });
  const { attempt } = await f.send();
  assert.equal(attempt.state, "uncertain");
  assert.equal(attempt.unconfirmed, undefined);
  f.emit(attempt.id);
  assert.equal(f.service.ledger.getAttempt(attempt.id).state, "uncertain");
});

test("an AgentPier restart leaves an old unconfirmed send unconfirmable", async (t) => {
  const f = await setup(t);
  const { attempt } = await f.send("Dann lass uns weiter machen");
  await f.service.close();
  // The new process counts its Gateway launches from 1 again.
  const g = await setup(t, { dataDir: f.dataDir });
  assert.equal(g.service.ledger.getAttempt(attempt.id).state, "uncertain");
  assert.equal(g.service.ledger.getAttempt(attempt.id).unconfirmed, undefined);
  g.gateway.transcript.push({
    role: "user",
    content: "Dann lass uns weiter machen",
    timestamp: 2,
    __openclaw: { id: "m1", idempotencyKey: `${attempt.id}:user` },
  });
  await g.service.reconcile();
  g.emit(attempt.id);
  assert.equal(g.service.ledger.getAttempt(attempt.id).state, "uncertain");
  assert.equal(g.tool("workspace"), false);
});
