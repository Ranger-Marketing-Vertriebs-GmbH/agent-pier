import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

const signal = () => new AbortController().signal;
const from = (updateId, chat, user, fields = { text: "Hello" }) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat,
    from: { id: user, is_bot: false },
    ...fields,
  },
});
function recording(f) {
  const sends = [];
  f.client.call = async (method, params) => {
    sends.push({ method, params });
    return { message_id: sends.length, chat: { id: Number(params.chat_id) } };
  };
  return sends;
}

test("an unknown private chat hears once per day that the bot is private and never reaches the model", async (t) => {
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const f = channelFixture(t, { now: () => clock, language: () => "en" });
  const sends = recording(f);
  await f.service.ingress.receive(f.channel.id, [
    from(1, { id: 77, type: "private" }, 77),
    from(2, { id: 77, type: "private" }, 77, { text: "Again" }),
  ]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.chat_id, "77");
  assert.equal(sends[0].params.text, serverCatalogs.en.assistants.telegramPrivateBot);
  assert.ok(!JSON.stringify(sends[0].params).includes("http"));
  clock += 23 * 3600_000;
  await f.service.ingress.receive(f.channel.id, [
    from(3, { id: 77, type: "private" }, 77),
  ]);
  assert.equal(sends.length, 1);
  clock += 3600_000;
  await f.service.ingress.receive(f.channel.id, [
    from(4, { id: 77, type: "private" }, 77),
    from(5, { id: 78, type: "private" }, 78),
  ]);
  assert.deepEqual(
    sends.map((s) => s.params.chat_id),
    ["77", "77", "78"],
  );
  // The paired user writing from a group is ignored without a reply.
  await f.service.ingress.receive(f.channel.id, [
    from(6, { id: -100, type: "group" }, 42),
    from(7, { id: -100, type: "supergroup" }, 43),
  ]);
  assert.equal(sends.length, 3);
  assert.deepEqual(f.service.store.get(f.channel.id).ignoredMessages, {
    private: 5,
    group: 2,
  });
  assert.deepEqual(f.service.ledger.list(f.channel.id), []);
  assert.deepEqual(f.service.outbox.all(f.channel.id), []);
  assert.equal(f.service.store.offset(f.channel.id), 8);
  await f.service.ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 0);
});

test("an unreachable stranger reply is not retried and does not stop polling", async (t) => {
  const f = channelFixture(t);
  let sends = 0;
  f.client.call = async () => {
    sends++;
    throw Object.assign(Error(), { code: "DELIVERY_UNCERTAIN" });
  };
  await f.service.ingress.receive(f.channel.id, [
    from(1, { id: 77, type: "private" }, 77),
    telegramMessage(2),
    from(3, { id: 77, type: "private" }, 77),
  ]);
  assert.equal(sends, 1);
  assert.equal(f.service.ledger.list(f.channel.id).length, 1);
  assert.equal(f.service.store.offset(f.channel.id), 4);
});

test("voice above the configured duration is rejected before download and the user hears the limit", async (t) => {
  for (const [options, duration, limit, language] of [
    [{}, 601, "10", "en"],
    [{ maxVoiceSeconds: 90 }, 91, "1.5", "en"],
    [{ maxVoiceSeconds: 90 }, 91, "1,5", "de"],
  ]) {
    const f = channelFixture(t, { ...options, language: () => language });
    f.client.audio = () => assert.fail("must not download");
    f.speech.save({ apiKey: "private-deepgram", revision: 0 });
    const update = telegramMessage(1);
    delete update.message.text;
    update.message.voice = {
      file_id: "voice",
      mime_type: "audio/ogg",
      file_size: 10,
      duration,
    };
    await f.service.ingress.receive(f.channel.id, [update]);
    await f.service.process(f.channel.id, signal());
    const [entry] = f.service.ledger.list(f.channel.id);
    assert.equal(entry.state, "failed");
    assert.equal(entry.diagnostic, "VOICE_TOO_LONG");
    const [notice] = f.service.outbox.all(f.channel.id);
    assert.equal(notice.kind, "input-rejected");
    assert.equal(
      notice.text,
      serverCatalogs[language].assistants.telegramVoiceTooLong(limit),
    );
    assert.equal(f.sent.length, 0);
  }
});

test("unsupported media is answered with the supported message types", async (t) => {
  const f = channelFixture(t, { language: () => "de" });
  const media = {
    photo: [{ file_id: "p" }],
    sticker: { file_id: "s" },
    document: { file_id: "d" },
    audio: { file_id: "a" },
    video_note: { file_id: "v" },
  };
  await f.service.ingress.receive(
    f.channel.id,
    Object.entries(media).map(([key, value], n) => {
      const update = telegramMessage(n + 1);
      delete update.message.text;
      update.message[key] = value;
      return update;
    }),
  );
  await f.service.ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 0);
  const entries = f.service.ledger.list(f.channel.id);
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    assert.equal(entry.state, "failed");
    assert.equal(entry.diagnostic, "MEDIA_UNSUPPORTED");
  }
  const notices = f.service.outbox.all(f.channel.id);
  assert.equal(notices.length, 5);
  for (const notice of notices)
    assert.equal(notice.text, serverCatalogs.de.assistants.telegramMediaUnsupported);
  // A duplicate update neither creates a second input nor a second notice.
  const again = telegramMessage(1);
  delete again.message.text;
  again.message.photo = media.photo;
  await f.service.ingress.receive(f.channel.id, [again]);
  assert.equal(f.service.outbox.all(f.channel.id).length, 5);
});

test("messages during runtime maintenance or an update stay queued and are delivered afterwards", async (t) => {
  const f = channelFixture(t);
  const pending = [telegramMessage(1, "During maintenance")];
  let polls = 0;
  f.client.call = async (method) => {
    if (method === "getUpdates") {
      polls++;
      return pending.splice(0);
    }
    return true;
  };
  f.assistants.maintenance = true;
  f.service.tick();
  await delay(20);
  assert.equal(polls, 0);
  assert.equal(f.service.ledger.list(f.channel.id).length, 0);
  // Updating: the runtime is back for polling but not ready for model work.
  f.assistants.maintenance = false;
  f.setReady(false);
  f.service.tick();
  await f.service.pollers.get(f.channel.id)?.task;
  await f.service.workers.get(f.channel.id)?.task;
  pending.push(telegramMessage(2, "During update"));
  f.service.tick();
  await f.service.pollers.get(f.channel.id)?.task;
  await f.service.workers.get(f.channel.id)?.task;
  assert.deepEqual(
    f.service.ledger.list(f.channel.id).map((e) => [e.text, e.state]),
    [
      ["During maintenance", "queued"],
      ["During update", "queued"],
    ],
  );
  assert.equal(f.sent.length, 0);
  f.setReady(true);
  await f.service.process(f.channel.id, signal());
  assert.deepEqual(
    f.sent.map((s) => s.text),
    ["During maintenance"],
  );
  const [first] = f.service.ledger.list(f.channel.id);
  f.assistants.ledger.transition(first.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", text: "Done", runId: first.attemptId }],
  });
  f.client.call = async (_m, params) => ({ message_id: 1, chat: { id: 42 }, params });
  await f.service.process(f.channel.id, signal());
  await f.service.process(f.channel.id, signal());
  assert.deepEqual(
    f.sent.map((s) => s.text),
    ["During maintenance", "During update"],
  );
});

test("service messages are ignored silently and captions on media are named in the reply", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const service = [
    { pinned_message: { message_id: 1 } },
    { new_chat_title: "Renamed" },
    { new_chat_members: [{ id: 5 }] },
    { message_auto_delete_timer_changed: { message_auto_delete_time: 60 } },
  ];
  await f.service.ingress.receive(
    f.channel.id,
    service.map((fields, n) => {
      const update = telegramMessage(n + 1);
      delete update.message.text;
      Object.assign(update.message, fields);
      return update;
    }),
  );
  assert.deepEqual(f.service.ledger.list(f.channel.id), []);
  assert.deepEqual(f.service.outbox.all(f.channel.id), []);
  assert.equal(f.service.store.offset(f.channel.id), 5);
  for (const [n, fields] of [
    [5, { photo: [{ file_id: "p" }], caption: "Plan dinner from this" }],
    [6, { document: { file_id: "d" }, caption: "  " }],
  ]) {
    const update = telegramMessage(n);
    delete update.message.text;
    Object.assign(update.message, fields);
    await f.service.ingress.receive(f.channel.id, [update]);
  }
  assert.deepEqual(
    f.service.outbox.all(f.channel.id).map((n) => n.text),
    [
      serverCatalogs.en.assistants.telegramMediaCaptionUnsupported,
      serverCatalogs.en.assistants.telegramMediaUnsupported,
    ],
  );
  await f.service.ingress.dispatch(f.channel.id);
  assert.equal(f.sent.length, 0);
});

test("the stranger reply is cancelled with the poll", async (t) => {
  const f = channelFixture(t);
  let received;
  f.client.call = async (method, _params, signal) => {
    if (method === "getUpdates") return [from(1, { id: 77, type: "private" }, 77)];
    received = signal;
    return { message_id: 1, chat: { id: 77 } };
  };
  const controller = new AbortController();
  await f.service.ingress.poll(f.channel.id, controller.signal);
  assert.equal(received, controller.signal);
});
