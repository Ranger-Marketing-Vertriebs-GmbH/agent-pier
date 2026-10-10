import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TelegramIngress } from "../../server/features/assistant-channels/telegram-ingress.js";
test("duplicate, reordered and foreign updates admit one durable model request", async (t) => {
  const f = channelFixture(t);
  const ingress = new TelegramIngress(f.service);
  await ingress.receive(f.channel.id, [
    telegramMessage(2),
    telegramMessage(1, "Earlier"),
    telegramMessage(2),
  ]);
  const foreign = telegramMessage(3, "Foreign");
  foreign.message.from.id = 43;
  await ingress.receive(f.channel.id, [foreign]);
  assert.equal(f.service.ledger.list(f.channel.id).length, 2);
  assert.equal(f.service.store.offset(f.channel.id), 4);
  await ingress.dispatch(f.channel.id);
  await ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 1);
  const [first] = f.service.ledger.list(f.channel.id);
  assert.equal(first.text, "Earlier");
  assert.equal(first.state, "running");
  // Simulate restart after model acceptance but before inbox association.
  f.service.ledger.patch(first.id, { state: "queued", requestId: null, attemptId: null });
  await ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 1);
});
test("disabled runtime retains input for later dispatch and polling conflict disables automatic polling", async (t) => {
  const f = channelFixture(t);
  const ingress = new TelegramIngress(f.service);
  f.setReady(false);
  await ingress.receive(f.channel.id, [telegramMessage(1)]);
  await ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.ledger.list(f.channel.id)[0].state, "queued");
  f.setReady(true);
  await ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 1);
  f.client.call = async () => {
    throw Object.assign(Error("upstream secret"), { code: "TELEGRAM_CONFLICT" });
  };
  await ingress.poll(f.channel.id);
  assert.equal(f.service.store.get(f.channel.id).diagnostic, "TELEGRAM_CONFLICT");
  assert.equal(f.service.store.get(f.channel.id).enabled, false);
});
test("polling honors Telegram retry timing and clears a recovered outage", async (t) => {
  const f = channelFixture(t);
  f.client.call = async () => {
    throw Object.assign(Error(), { code: "TELEGRAM_RATE_LIMIT", retryAfter: 20 });
  };
  await f.service.ingress.poll(f.channel.id);
  assert.equal(f.service.store.get(f.channel.id).diagnostic, "TELEGRAM_RATE_LIMIT");
  assert.ok(f.service.store.get(f.channel.id).pollAfter > Date.now() + 19000);
  f.client.call = async () => [];
  await f.service.ingress.poll(f.channel.id);
  assert.equal(f.service.store.get(f.channel.id).diagnostic, null);
});
