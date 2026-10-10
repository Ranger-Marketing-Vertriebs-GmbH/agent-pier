import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelStore } from "../../server/features/assistant-channels/channel-store.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-channels-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new ChannelStore({ dataDir });
  t.after(() => store.close());
  return { store, dataDir };
}
test("channel credentials are private, bot ownership unique and edits revision checked", (t) => {
  const { store } = fixture(t);
  const c = store.create({
    assistantId: "assistant",
    conversationId: "conversation",
    botId: 123,
    username: "test_bot",
    token: "123:private-token",
  });
  assert.equal(c.hasSecret, true);
  assert.equal(c.enabled, false);
  assert.ok(!JSON.stringify(store.list()).includes("private-token"));
  assert.throws(
    () =>
      store.create({
        assistantId: "other",
        conversationId: "c2",
        botId: 123,
        username: "test_bot",
        token: "123:other",
      }),
    { status: 409 },
  );
  assert.throws(() => store.update(c.id, { enabled: true }, c.revision), { status: 400 });
  assert.throws(() => store.update(c.id, { enabled: false }, 0), { status: 409 });
  store.disconnect(c.id, c.revision);
  assert.equal(store.get(c.id).hasSecret, false);
  assert.equal(store.secret(c.id), null);
});
test("pairing requires a current one-time code from a private human chat and persists exact identity", (t) => {
  const { store, dataDir } = fixture(t);
  const c = store.create({
    assistantId: "a",
    conversationId: "c",
    botId: 12,
    username: "test_bot",
    token: "12:private",
  });
  const pairing = store.pairing(c.id, c.revision);
  const message = {
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
    text: `/start ${pairing.code}`,
  };
  assert.equal(
    store.acceptPair(c.id, { ...message, chat: { id: -1, type: "group" } }),
    false,
  );
  assert.equal(store.acceptPair(c.id, { ...message, text: "/start wrong" }), false);
  assert.equal(store.acceptPair(c.id, message), true);
  assert.equal(store.acceptPair(c.id, message), false);
  assert.equal(store.get(c.id).chatId, "42");
  assert.equal(store.get(c.id).userId, "42");
  assert.equal(store.get(c.id).enabled, true);
  const reopened = new ChannelStore({ dataDir });
  t.after(() => reopened.close());
  assert.equal(reopened.get(c.id).chatId, "42");
  assert.ok(!JSON.stringify(store.list()).includes(pairing.code));
});
test("central speech credentials can be rotated or removed without exposing the key", (t) => {
  const { dataDir } = fixture(t);
  const speech = new SpeechConnections({ dataDir });
  t.after(() => speech.close());
  const saved = speech.save({
    apiKey: "private-deepgram",
    model: "nova-3",
    language: "auto",
    revision: 0,
  });
  assert.equal(saved.hasSecret, true);
  assert.ok(!JSON.stringify(saved).includes("private-deepgram"));
  const lease = speech.acquire();
  assert.equal(lease.apiKey, "private-deepgram");
  assert.throws(() => speech.save({ removeApiKey: true, revision: saved.revision }), {
    status: 409,
  });
  lease.release();
  speech.save({ removeApiKey: true, revision: saved.revision });
  assert.equal(speech.get().hasSecret, false);
  assert.throws(() => speech.acquire(), { status: 400 });
});

test("rotating or disconnecting a bot token destroys update backup keys first", (t) => {
  const { store, dataDir } = fixture(t);
  const keys = path.join(dataDir, "assistants", "backup-keys");
  const key = path.join(keys, "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01.key");
  const seed = () => {
    fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
    fs.writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 });
  };
  const c = store.create({
    assistantId: "assistant",
    conversationId: "conversation",
    botId: 7,
    username: "key_bot",
    token: "7:first",
  });
  seed();
  assert.throws(() => store.rotate(c.id, "7:second", 0), { status: 409 });
  assert.equal(fs.existsSync(key), true, "a rejected rotation keeps the key");
  const rotated = store.rotate(c.id, "7:second", c.revision);
  assert.equal(fs.existsSync(key), false);
  seed();
  store.disconnect(c.id, rotated.revision);
  assert.equal(fs.existsSync(key), false);
});
