import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TelegramDelivery } from "../../server/features/assistant-channels/telegram-delivery.js";
async function ready(t, text = "Dinner is ready", options = {}) {
  const f = channelFixture(t, options);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", text, runId: entry.attemptId }],
  });
  return { ...f, entry, delivery: new TelegramDelivery(f.service) };
}
test("final reply is split without corrupting Unicode and each remote acknowledgement is durable", async (t) => {
  const f = await ready(t, "🙂".repeat(2200));
  const sent = [];
  f.client.call = async (method, params) => {
    assert.equal(method, "sendMessage");
    assert.equal(params.chat_id, "42");
    assert.equal(f.service.ledger.get(f.entry.id).state, "delivering");
    assert.ok(params.text.length <= 4000);
    assert.ok(!/[\uD800-\uDBFF]$/.test(params.text));
    sent.push(params.text);
    return { message_id: sent.length, chat: { id: 42 } };
  };
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(sent.join(""), "🙂".repeat(2200));
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivered");
  assert.deepEqual(f.service.ledger.get(f.entry.id).remoteMessageIds, [1, 2]);
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(sent.length, 2);
});
test("lost acknowledgement is uncertain and never retried automatically", async (t) => {
  const f = await ready(t);
  let sends = 0;
  f.client.call = async () => {
    sends++;
    throw Error("lost after acceptance");
  };
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivery_uncertain");
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
});
test("rate limit proves nonacceptance and retains a bounded retry deadline", async (t) => {
  const f = await ready(t);
  let sends = 0;
  f.client.call = async () => {
    sends++;
    if (sends === 1)
      throw Object.assign(Error(), { code: "TELEGRAM_RATE_LIMIT", retryAfter: 2 });
    return { message_id: 7, chat: { id: 42 } };
  };
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).state, "outbound");
  assert.ok(f.service.ledger.get(f.entry.id).nextDeliveryAt > Date.now());
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
  f.service.ledger.patch(f.entry.id, { nextDeliveryAt: 0 });
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivered");
});
test("unrelated history and cancelled requests never become Telegram replies", async (t) => {
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const f = await ready(t, "unused", { now: () => clock });
  f.client.call = () => assert.fail("must not send another run's text");
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", text: "Private other run", runId: "foreign" }],
  });
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).diagnostic, "REPLY_UNAVAILABLE");
  clock += 60_000;
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).state, "reply_unavailable");
  await f.service.recoverInput(f.channel.id, f.entry.id, "review");
  assert.equal(f.service.ledger.get(f.entry.id).state, "reviewed");
  const second = telegramMessage(2, "Cancelled");
  await f.service.ingress.receive(f.channel.id, [second]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[1];
  f.assistants.ledger.transition(entry.attemptId, "cancelled");
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(entry.id).state, "cancelled");
});
test("delivery refuses a binding that differs from the persisted input destination", async (t) => {
  const f = await ready(t);
  const current = f.service.store.get(f.channel.id);
  f.service.store.write({ ...current, chatId: "43", userId: "43" }, current.revision);
  f.client.call = () => assert.fail("must not send to a changed destination");
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivery_failed");
  assert.equal(
    f.service.ledger.get(f.entry.id).diagnostic,
    "CHANNEL_DESTINATION_CHANGED",
  );
});
test("late confirmed model completion remains eligible after uncertain execution", async (t) => {
  const f = await ready(t);
  f.service.ledger.patch(f.entry.id, { state: "model_uncertain" });
  f.client.call = async () => ({ message_id: 9, chat: { id: 42 } });
  await f.delivery.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.ledger.get(f.entry.id).state, "delivered");
});
