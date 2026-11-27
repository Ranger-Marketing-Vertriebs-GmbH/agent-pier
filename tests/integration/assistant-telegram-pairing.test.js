import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

// Records the bot's sendMessage calls; `fail` makes Telegram unreachable.
function messages(f, { fail = false } = {}) {
  const sent = [];
  f.client.call = async (method, params) => {
    if (method !== "sendMessage") return [];
    if (fail) throw Object.assign(new Error("offline"), { code: "TELEGRAM_NETWORK" });
    sent.push(params);
    return { message_id: sent.length, chat: { id: Number(params.chat_id) } };
  };
  return sent;
}
const start = (code, chat = 43) => {
  const update = telegramMessage(1, `/start ${code}`);
  update.message.chat.id = update.message.from.id = chat;
  return update;
};

test("a redeemed pairing code is confirmed once in the new chat, in its language", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const sent = messages(f);
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  const update = start(pair.code);
  await f.service.ingress.receive(f.channel.id, [update]);
  assert.equal(f.service.store.get(f.channel.id).chatId, "43");
  assert.deepEqual(sent, [
    { chat_id: "43", text: serverCatalogs.en.assistants.telegramPaired("Home") },
  ]);
  // The /start message never reaches the agent, and nothing waits in the outbox.
  assert.equal(f.service.ledger.list(f.channel.id).length, 0);
  assert.deepEqual(f.service.outbox.pending(f.channel.id), []);
  // The same update again (a retried poll) redeems nothing and confirms nothing.
  await f.service.ingress.receive(f.channel.id, [update]);
  assert.equal(sent.length, 1);
});

test("an unreachable Telegram leaves the pairing in place and disconnecting free", async (t) => {
  const f = channelFixture(t);
  messages(f, { fail: true });
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  await f.service.ingress.receive(f.channel.id, [start(pair.code)]);
  const channel = f.service.store.get(f.channel.id);
  assert.equal(channel.enabled, true);
  assert.equal(channel.chatId, "43");
  await f.service.disconnect(f.channel.id, channel.revision);
  assert.equal(f.service.store.get(f.channel.id).hasSecret, false);
});

test("a wrong pairing code is never answered", async (t) => {
  const f = channelFixture(t);
  const sent = messages(f);
  await f.service.pair(f.channel.id, f.channel.revision);
  await f.service.ingress.receive(f.channel.id, [start("x".repeat(32))]);
  assert.deepEqual(sent, []);
  assert.ok(f.service.store.get(f.channel.id).pairingExpiresAt > 0);
});

test("an expired pairing code is never answered", async (t) => {
  const f = channelFixture(t);
  const sent = messages(f);
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  f.service.store.db
    .prepare("UPDATE channel_pairing SET expires=? WHERE id=?")
    .run(Date.now() - 1, f.channel.id);
  await f.service.ingress.receive(f.channel.id, [start(pair.code)]);
  assert.deepEqual(sent, []);
  assert.notEqual(f.service.store.get(f.channel.id).chatId, "43");
});

test("without a readable agent record the confirmation stays generic, in German", async (t) => {
  const f = channelFixture(t);
  const sent = messages(f);
  f.assistants.store.getAssistant = () => {
    throw new Error("gone");
  };
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  await f.service.ingress.receive(f.channel.id, [start(pair.code)]);
  assert.deepEqual(sent, [
    { chat_id: "43", text: serverCatalogs.de.assistants.telegramPairedPlain },
  ]);
});
