import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { ExecApprovals } from "../../server/features/assistants/exec-approvals.js";
import { replyGraceMs } from "../../server/features/assistant-channels/telegram-delivery.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const signal = () => new AbortController().signal;

// A Telegram channel with exec approvals from a fake Gateway. Each turn's trusted
// context is the one its sender recorded (Telegram ingress or the web).
async function setup(t) {
  const f = await workflowFixture(t);
  const agent = f.store.getAssistant(f.id);
  f.store.updateAssistant(f.id, { shell: "approval" }, agent.revision);
  const contexts = new Map();
  const send = f.assistants.send;
  f.assistants.send = async (id, input, context = { kind: "owner" }) => {
    const sent = await send(id, input, context);
    contexts.set(sent.request.id, context);
    return sent;
  };
  f.assistants.teams = {
    store: { context: (id) => contexts.get(id) || { kind: "owner" }, list: () => [] },
  };
  const emitter = new EventEmitter();
  const gateway = {
    ready: true,
    calls: [],
    async call(method, params) {
      this.calls.push({ method, params });
      return [];
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
  f.assistants.runtime.client = gateway;
  f.assistants.gatewayEvents = new GatewayEventHub();
  f.assistants.gatewayEvents.bind(gateway);
  const exec = new ExecApprovals(f.workflows, { log: () => {} });
  t.after(() => exec.close());
  const emit = (event, payload) => emitter.emit("event", { event, payload });
  const telegram = [];
  f.client.call = async (method, input) => {
    telegram.push({ method, input });
    return method === "sendMessage"
      ? { message_id: 100 + telegram.length, chat: { id: 42 } }
      : true;
  };
  let n = 0;
  return {
    ...f,
    agent,
    gateway,
    telegram,
    texts: () =>
      telegram.filter((c) => c.method === "sendMessage").map((c) => c.input.text),
    async turn(text = "Check the host") {
      await f.service.ingress.receive(f.channel.id, [telegramMessage(++n, text)]);
      await f.service.ingress.dispatch(f.channel.id);
      return f.service.ledger.list(f.channel.id).at(-1);
    },
    async request(id, runId, command = "git status") {
      emit("exec.approval.requested", {
        id,
        request: {
          command,
          cwd: "/work",
          agentId: agent.runtimeAgentId,
          sessionKey: "session",
          runId,
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 1800000,
      });
      await settle();
      await f.workflows.tick();
      await f.service.teamOutbox.process(f.channel.id, signal());
    },
    async allow(id) {
      emit("exec.approval.resolved", {
        id,
        decision: "allow-once",
        resolvedBy: "telegram",
        ts: Date.now(),
      });
      await settle();
    },
    reply(attemptId, text) {
      f.assistants.history = async () => ({
        stale: false,
        messages: [{ role: "assistant", runId: attemptId, text }],
      });
    },
  };
}

test("a Telegram turn whose approvals were granted inline still sends its final reply", async (t) => {
  const f = await setup(t);
  const entry = await f.turn();
  for (const id of ["approval-1", "approval-2"]) {
    await f.request(id, entry.attemptId);
    await f.allow(id);
  }
  const cards = f.service.outbox
    .all(f.channel.id)
    .filter((n) => n.kind === "action-approval");
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.state === "delivered"));
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.reply(entry.attemptId, "Done: https://example.test/report");

  await f.service.delivery.process(f.channel.id, signal());

  const done = f.service.ledger.get(entry.id);
  assert.equal(done.state, "delivered");
  assert.equal(done.parts.length, 1);
  assert.match(done.parts[0].text, /Done: https:\/\/example\.test\/report/);
  const texts = f.texts();
  assert.equal(texts.length, 3);
  assert.match(texts[0], /git status/);
  assert.match(texts[2], /Done/);
  // The entry names every message of the turn: the approval cards and the reply.
  assert.deepEqual(done.remoteMessageIds, [
    ...cards.flatMap((c) => c.remoteMessageIds),
    done.parts[0].messageId,
  ]);
  // Delivered once: another pass sends nothing more.
  await f.service.delivery.process(f.channel.id, signal());
  assert.equal(f.texts().length, 3);
});

test("a turn that ends waiting on an approval keeps its card as the reply", async (t) => {
  const f = await setup(t);
  const entry = await f.turn();
  await f.request("approval-1", entry.attemptId);
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.reply(entry.attemptId, "I asked for your approval.");

  await f.service.delivery.process(f.channel.id, signal());

  const [card] = f.service.outbox.all(f.channel.id);
  const done = f.service.ledger.get(entry.id);
  assert.equal(done.state, "delivered");
  assert.deepEqual(done.remoteMessageIds, card.remoteMessageIds);
  assert.equal(done.parts, undefined);
  assert.equal(f.texts().length, 1);
});

test("granted approvals without reply text wait for it, then stand in for the reply", async (t) => {
  const f = await setup(t);
  let now = 1000;
  f.service.now = () => now;
  const entry = await f.turn();
  await f.request("approval-1", entry.attemptId);
  await f.allow("approval-1");
  f.assistants.ledger.transition(entry.attemptId, "completed");

  await f.service.delivery.process(f.channel.id, signal());
  assert.equal(f.service.ledger.get(entry.id).state, "running");

  now += replyGraceMs;
  await f.service.delivery.process(f.channel.id, signal());
  const [card] = f.service.outbox.all(f.channel.id);
  const done = f.service.ledger.get(entry.id);
  assert.equal(done.state, "delivered");
  assert.deepEqual(done.remoteMessageIds, card.remoteMessageIds);
  assert.equal(f.texts().length, 1);
});

test("a follow-up run AgentPier cannot place asks in the Telegram chat of the latest turn", async (t) => {
  const f = await setup(t);
  const entry = await f.turn();
  f.assistants.ledger.transition(entry.attemptId, "completed");

  // OpenClaw starts its own run in the same session (no AgentPier request).
  await f.request("approval-1", "openclaw-follow-up");

  const [action] = f.workflows.store.list();
  assert.equal(action.state, "awaiting_approval");
  assert.equal(action.attemptId, undefined);
  assert.deepEqual(action.origin, {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  });
  const [card] = f.service.outbox.all(f.channel.id);
  assert.equal(card.kind, "action-approval");
  assert.equal(card.state, "delivered");
  assert.match(f.texts()[0], /git status/);
  // The owner answers it from Telegram; the decision reaches the Gateway.
  const allow = card.actions.find((a) => a.decision === "allow-once").handle;
  await f.service.ingress.receive(f.channel.id, [
    {
      update_id: 99,
      callback_query: {
        id: "callback",
        data: allow,
        from: { id: 42, is_bot: false },
        message: { message_id: 101, chat: { id: 42, type: "private" } },
      },
    },
  ]);
  assert.ok(
    f.gateway.calls.some(
      (c) =>
        c.method === "exec.approval.resolve" &&
        c.params.id === "approval-1" &&
        c.params.decision === "allow-once",
    ),
  );
});

test("a follow-up run after a web turn, or without a paired chat, asks only in the web", async (t) => {
  const f = await setup(t);
  await f.turn();
  // The owner's latest turn came from the web.
  await f.invocation("web-turn");
  await f.request("approval-1", "openclaw-follow-up");
  assert.deepEqual(f.workflows.store.list()[0].origin, { kind: "owner" });

  // A Telegram turn, but the chat is no longer enabled.
  await f.turn("Again");
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, enabled: false }, channel.revision);
  await f.request("approval-2", "openclaw-follow-up-2");
  const second = f.workflows.store
    .list()
    .find((a) => a.payload.approvalId === "approval-2");
  assert.deepEqual(second.origin, { kind: "owner" });
  assert.equal(f.texts().length, 0);
});
