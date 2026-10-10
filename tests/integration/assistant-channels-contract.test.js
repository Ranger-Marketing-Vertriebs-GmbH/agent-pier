import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { ChannelStore } from "../../server/features/assistant-channels/channel-store.js";
import { ChannelLedger } from "../../server/features/assistant-channels/channel-ledger.js";
test("persistent inbox recovers interrupted states without replaying uncertain output", async (t) => {
  const f = channelFixture(t);
  await f.service.ingress.receive(f.channel.id, [
    telegramMessage(1),
    telegramMessage(2),
    telegramMessage(3),
  ]);
  const [sending, transcribing, dispatching] = f.service.ledger.list(f.channel.id);
  f.service.ledger.patch(sending.id, {
    state: "delivering",
    parts: [{ text: "Reply", state: "sending" }],
    remoteMessageIds: [],
  });
  f.service.ledger.patch(transcribing.id, { state: "transcribing" });
  f.service.ledger.patch(dispatching.id, { state: "dispatching" });
  const reopened = new ChannelStore({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  const ledger = new ChannelLedger(reopened.db);
  assert.equal(reopened.offset(f.channel.id), 4);
  assert.equal(ledger.get(sending.id).state, "delivery_uncertain");
  assert.equal(ledger.get(transcribing.id).state, "transcription_failed");
  assert.equal(ledger.get(dispatching.id).state, "queued");
  await assert.rejects(f.service.recoverInput(f.channel.id, sending.id, "retry"), {
    status: 400,
  });
  await f.service.recoverInput(f.channel.id, sending.id, "review");
  assert.equal(ledger.get(sending.id).state, "reviewed");
});
test("late poll cannot admit input after disconnect and outstanding work blocks re-pairing", async (t) => {
  const f = channelFixture(t);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  await assert.rejects(f.service.pair(f.channel.id, f.channel.revision), { status: 409 });
  let respond, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  f.client.call = () => {
    entered();
    return new Promise((r) => {
      respond = r;
    });
  };
  const polling = f.service.ingress.poll(f.channel.id);
  await started;
  await f.service.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  respond([telegramMessage(2)]);
  await polling;
  assert.equal(f.service.ledger.list(f.channel.id).length, 1);
  assert.equal(f.service.store.get(f.channel.id).hasSecret, false);
});
test("resuming invalidates pairing links and keeps active replies in their source chat", async (t) => {
  const f = channelFixture(t);
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  await f.service.update(f.channel.id, {
    enabled: true,
    revision: pair.channel.revision,
  });
  await f.service.ingress.receive(f.channel.id, [
    telegramMessage(1, "Private question from 42"),
  ]);
  const foreign = telegramMessage(2, `/start ${pair.code}`);
  foreign.message.chat.id = foreign.message.from.id = 43;
  await f.service.ingress.receive(f.channel.id, [foreign]);
  assert.equal(f.service.store.get(f.channel.id).chatId, "42");
  assert.equal(f.service.store.get(f.channel.id).pairingExpiresAt, null);
  const entry = f.service.ledger.list(f.channel.id)[0];
  assert.equal(entry.chatId, "42");
  assert.equal(entry.userId, "42");
});
test("re-pairing accepts overlapping message IDs from different private chats", async (t) => {
  const f = channelFixture(t);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  f.service.ledger.patch(f.service.ledger.list(f.channel.id)[0].id, {
    state: "delivered",
  });
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  const pairing = telegramMessage(2, `/start ${pair.code}`);
  pairing.message.chat.id = pairing.message.from.id = 43;
  const input = telegramMessage(3, "New owner message");
  input.message.chat.id = input.message.from.id = 43;
  input.message.message_id = 1;
  await f.service.ingress.receive(f.channel.id, [pairing, input]);
  assert.equal(f.service.ledger.list(f.channel.id).length, 2);
  assert.equal(f.service.ledger.list(f.channel.id)[1].text, "New owner message");
});
test("pair redemption is refused if work appears while a link is outstanding", async (t) => {
  const f = channelFixture(t);
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  f.service.ledger.accept(f.channel, telegramMessage(1));
  const foreign = telegramMessage(2, `/start ${pair.code}`);
  foreign.message.chat.id = foreign.message.from.id = 43;
  assert.equal(f.service.store.acceptPair(f.channel.id, foreign.message), false);
  assert.equal(f.service.store.get(f.channel.id).chatId, "42");
});
test("legacy inbox migration preserves evidence without guessing missing destinations", async (t) => {
  const f = channelFixture(t);
  const db = f.service.store.db;
  db.exec(`DROP TABLE channel_inbox;
    CREATE TABLE channel_inbox(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), update_id INTEGER NOT NULL, message_id INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(channel_id,update_id), UNIQUE(channel_id,message_id));`);
  db.prepare("INSERT INTO channel_inbox VALUES(?,?,?,?,?)").run(
    "legacy",
    f.channel.id,
    1,
    1,
    JSON.stringify({
      id: "legacy",
      channelId: f.channel.id,
      state: "delivering",
      text: "Legacy input",
    }),
  );
  const ledger = new ChannelLedger(db);
  assert.equal(ledger.get("legacy").state, "delivery_uncertain");
  assert.equal(ledger.get("legacy").chatId, undefined);
  ledger.accept(f.channel, telegramMessage(2));
  assert.equal(ledger.list(f.channel.id).length, 2);
  const reopened = new ChannelLedger(db);
  assert.equal(reopened.list(f.channel.id).length, 2);
});
test("public recovery retains the oldest blocker beyond the recent history limit", async (t) => {
  const f = channelFixture(t);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  const blocked = f.service.ledger.list(f.channel.id)[0];
  f.service.ledger.patch(blocked.id, { state: "transcription_failed" });
  for (let i = 2; i <= 202; i++) {
    const entry = f.service.ledger.accept(f.channel, telegramMessage(i));
    f.service.ledger.patch(entry.id, { state: "failed" });
  }
  assert.ok(
    f.service.ledger.public(f.channel.id).some((entry) => entry.id === blocked.id),
  );
});
