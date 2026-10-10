import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { ChannelLedger } from "../../server/features/assistant-channels/channel-ledger.js";
import { ChannelOutbox } from "../../server/features/assistant-channels/channel-outbox.js";

async function proposed(t) {
  const f = channelFixture(t);
  f.assistants.models = { resolve: async () => ({ release() {} }) };
  f.assistants.teams = new TeamService({ assistants: f.assistants, autoStart: false });
  t.after(() => f.assistants.teams.close());
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1, "Plan a team")]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.assistants.teams.store.recordContext(entry.requestId, {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  });
  const team = await f.assistants.teams.propose(
    { attemptId: entry.attemptId, toolCallId: "proposal", assertCurrent() {} },
    {
      objective: "Plan dinner",
      members: [{ name: "Planner", role: "Plan", assignment: "Suggest dinner" }],
    },
  );
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [
      { role: "assistant", runId: entry.attemptId, text: "Please approve my team" },
    ],
  });
  const sends = [];
  f.client.call = async (method, input) => {
    assert.equal(method, "sendMessage");
    sends.push(input);
    return { message_id: sends.length, chat: { id: 42 } };
  };
  return { ...f, entry, team, sends, signal: new AbortController().signal };
}

test("a proposal turn sends only the authoritative approval with buttons", async (t) => {
  const f = await proposed(t);
  await f.service.process(f.channel.id, f.signal);
  await f.service.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].reply_markup.inline_keyboard[0].length, 2);
  assert.match(f.sends[0].text, /Suggest dinner/);
  const input = f.service.ledger.get(f.entry.id);
  assert.equal(input.state, "delivered");
  assert.deepEqual(input.remoteMessageIds, [1]);
});

test("a proposal awaiting outbox transfer cannot leak the model approval reply", async (t) => {
  const f = await proposed(t);
  await f.service.delivery.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 0);
  assert.equal(f.service.ledger.get(f.entry.id).state, "running");
  await f.service.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 1);
});

test("a decision before the model reply completes does not resend a stale approval", async (t) => {
  const f = await proposed(t);
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.process(f.channel.id, f.signal);
  f.assistants.teams.decide(
    f.team.id,
    {
      revision: f.assistants.teams.store.get(f.team.id).revision,
      decision: "approve",
    },
    { kind: "owner" },
  );
  await f.service.delivery.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 1);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivered");
});

test("an unconfirmed approval stays recoverable without a second plain-text reply", async (t) => {
  const f = await proposed(t);
  let sends = 0;
  f.client.call = async () => {
    sends++;
    throw Error("acknowledgement lost");
  };
  await f.service.process(f.channel.id, f.signal);
  f.service.ledger = new ChannelLedger(f.service.store.db);
  f.service.outbox = new ChannelOutbox(f.service.store.db);
  await f.service.process(f.channel.id, f.signal);
  const notification = f.service.outbox.all(f.channel.id)[0];
  assert.equal(sends, 1);
  assert.equal(notification.state, "delivery_uncertain");
  assert.equal(f.service.ledger.get(f.entry.id).state, "running");
  await f.service.recoverNotification(f.channel.id, notification.id, "review");
  await f.service.process(f.channel.id, f.signal);
  assert.equal(sends, 1);
  assert.equal(f.service.ledger.get(f.entry.id).state, "reviewed");
});

test("persisted approval acknowledgement completes the input after worker reconstruction", async (t) => {
  const f = await proposed(t);
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.process(f.channel.id, f.signal);
  f.service.ledger = new ChannelLedger(f.service.store.db);
  f.service.outbox = new ChannelOutbox(f.service.store.db);
  await f.service.delivery.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 1);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivered");
  assert.deepEqual(f.service.ledger.get(f.entry.id).remoteMessageIds, [1]);
});

test("blocked approval delivery does not advertise a completed model turn as typing", async (t) => {
  const f = await proposed(t);
  f.service.ledger.patch(f.entry.id, { receipt: "confirmed" });
  f.client.call = async () => {
    throw Error("acknowledgement lost");
  };
  await f.service.process(f.channel.id, f.signal);
  const calls = [];
  f.client.call = async (method) => calls.push(method);
  await f.service.feedback.process(f.channel.id, f.signal);
  assert.deepEqual(calls, []);
});

test("an earlier proposal cannot suppress a later ordinary reply", async (t) => {
  const f = await proposed(t);
  await f.service.process(f.channel.id, f.signal);
  f.sends.length = 0;
  await f.service.ingress.receive(f.channel.id, [telegramMessage(2, "Another question")]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[1];
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", runId: entry.attemptId, text: "Ordinary answer" }],
  });
  await f.service.process(f.channel.id, f.signal);
  assert.deepEqual(
    f.sends.map((m) => m.text),
    ["Ordinary answer"],
  );
});

test("a foreign proposal destination cannot consume the input reply", async (t) => {
  const f = await proposed(t);
  const store = f.assistants.teams.store;
  const team = store.get(f.team.id);
  store.write(team, { origin: { ...team.origin, chatId: "43", userId: "43" } });
  await f.service.delivery.process(f.channel.id, f.signal);
  assert.deepEqual(
    f.sends.map((m) => m.text),
    ["Please approve my team"],
  );
});

test("an approval rejected by Telegram is retried only through notification recovery", async (t) => {
  const f = await proposed(t);
  const send = f.client.call;
  f.client.call = async () => {
    throw Object.assign(Error("rejected"), { rejected: true });
  };
  await f.service.process(f.channel.id, f.signal);
  const notification = f.service.outbox.all(f.channel.id)[0];
  assert.equal(notification.state, "delivery_failed");
  assert.equal(f.service.ledger.get(f.entry.id).state, "running");
  f.client.call = send;
  await f.service.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 0);
  await f.service.recoverNotification(f.channel.id, notification.id, "retry");
  await f.service.process(f.channel.id, f.signal);
  assert.equal(f.sends.length, 1);
  assert.ok(f.sends[0].reply_markup);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivered");
});
