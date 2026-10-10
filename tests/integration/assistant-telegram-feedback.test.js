import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
const signal = () => new AbortController().signal;
test("accepted input gets one durable eyes reaction and duplicate or foreign inputs get none", async (t) => {
  const f = channelFixture(t),
    calls = [];
  const foreign = telegramMessage(2);
  foreign.message.from.id = 99;
  await f.service.ingress.receive(f.channel.id, [
    telegramMessage(1),
    telegramMessage(1),
    foreign,
  ]);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.client.call = async (method, params) => {
    if (method === "setMessageReaction")
      assert.equal(f.service.ledger.get(entry.id).receipt, "attempted");
    calls.push({ method, params });
    return true;
  };
  await f.service.feedback.process(f.channel.id, signal());
  await f.service.feedback.process(f.channel.id, signal());
  assert.deepEqual(
    calls.filter((c) => c.method === "setMessageReaction"),
    [
      {
        method: "setMessageReaction",
        params: {
          chat_id: "42",
          message_id: 1,
          reaction: [{ type: "emoji", emoji: "👀" }],
          is_big: false,
        },
      },
    ],
  );
  assert.equal(f.service.ledger.get(entry.id).receipt, "confirmed");
});
test("typing renews during transcription and stops for blocked or completed work", async (t) => {
  const f = channelFixture(t),
    calls = [];
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.service.ledger.patch(entry.id, { receipt: "confirmed", state: "transcribing" });
  f.client.call = async (method, params) => {
    calls.push({ method, params });
    return true;
  };
  await f.service.feedback.process(f.channel.id, signal());
  t.mock.timers.tick(3000);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1000);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    method: "sendChatAction",
    params: { chat_id: "42", action: "typing" },
  });
  for (const state of [
    "transcription_failed",
    "model_uncertain",
    "delivery_uncertain",
    "delivered",
  ]) {
    f.service.ledger.patch(entry.id, { state });
    t.mock.timers.tick(5000);
    await f.service.feedback.process(f.channel.id, signal());
  }
  assert.equal(calls.length, 2);
});
test("feedback failure never retries an uncertain reaction or blocks model dispatch", async (t) => {
  const f = channelFixture(t);
  let reactions = 0;
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  f.client.call = async (method) => {
    if (method === "setMessageReaction") reactions++;
    throw Error("network failure");
  };
  await f.service.feedback.process(f.channel.id, signal());
  await f.service.ingress.dispatch(f.channel.id);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(reactions, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.service.ledger.list(f.channel.id)[0].state, "running");
});
test("paused, foreign-destination and aborted feedback never contacts Telegram", async (t) => {
  const f = channelFixture(t);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  f.client.call = () => assert.fail("no feedback permitted");
  const abort = new AbortController();
  abort.abort();
  await f.service.feedback.process(f.channel.id, abort.signal);
  let channel = f.service.store.update(
    f.channel.id,
    { enabled: false },
    f.channel.revision,
  );
  await f.service.feedback.process(f.channel.id, signal());
  f.service.store.write(
    { ...channel, enabled: true, chatId: "43", userId: "43" },
    channel.revision,
  );
  await f.service.feedback.process(f.channel.id, signal());
});
test("slow feedback runs separately from model processing and is joined on disconnect", async (t) => {
  const f = channelFixture(t);
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  let entered;
  const started = new Promise((r) => {
    entered = r;
  });
  f.client.call = async (method, params, signal) => {
    if (method === "getUpdates") return [];
    entered();
    await new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  };
  f.service.tick();
  await Promise.race([
    started,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("feedback never started")), 1000),
    ),
  ]);
  await f.service.workers.get(f.channel.id)?.task;
  assert.equal(f.sent.length, 1);
  await f.service.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  assert.equal(f.service.feedbackWorkers.size, 0);
});
test("an old unreplied receipt cannot hide receipts after a legitimate chat change", async (t) => {
  const f = channelFixture(t),
    reactions = [];
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  f.service.ledger.patch(f.service.ledger.list(f.channel.id)[0].id, {
    state: "delivered",
  });
  const pair = await f.service.pair(f.channel.id, f.channel.revision);
  const start = telegramMessage(2, `/start ${pair.code}`);
  const input = telegramMessage(3);
  for (const update of [start, input])
    update.message.chat.id = update.message.from.id = 43;
  await f.service.ingress.receive(f.channel.id, [start, input]);
  f.client.call = async (method, params) => {
    if (method === "setMessageReaction") reactions.push(params);
    return true;
  };
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].chat_id, "43");
  assert.equal(reactions[0].message_id, 3);
});
test("Telegram rate limits pause optional feedback without changing the inbox", async (t) => {
  const f = channelFixture(t);
  let calls = 0;
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1), telegramMessage(2)]);
  f.client.call = async () => {
    calls++;
    throw Object.assign(Error(), { code: "TELEGRAM_RATE_LIMIT", retryAfter: 30 });
  };
  await f.service.feedback.process(f.channel.id, signal());
  const previous = calls;
  t.mock.timers.tick(5000);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(calls, previous);
  assert.equal(f.service.ledger.list(f.channel.id)[1].receipt, "pending");
  t.mock.timers.tick(25000);
  await f.service.feedback.process(f.channel.id, signal());
  assert.ok(calls > previous);
});
test("an unresolved earlier conversation attempt does not advertise queued work as typing", async (t) => {
  const f = channelFixture(t),
    calls = [];
  const earlier = await f.assistants.send(f.channel.conversationId, {
    clientRequestId: "earlier-web-input",
    text: "Earlier request",
  });
  f.assistants.ledger.transition(earlier.attempt.id, "uncertain");
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  f.client.call = async (method) => {
    calls.push(method);
    return true;
  };
  await f.service.ingress.dispatch(f.channel.id);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(f.service.ledger.list(f.channel.id)[0].state, "queued");
  assert.deepEqual(calls, ["setMessageReaction"]);
});
test("simultaneous rate limits retain the longest provider deadline", async (t) => {
  const f = channelFixture(t);
  let calls = 0;
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1), telegramMessage(2)]);
  f.service.ledger.patch(f.service.ledger.list(f.channel.id)[0].id, {
    state: "transcribing",
  });
  f.client.call = async (method) => {
    calls++;
    throw Object.assign(Error(), {
      code: "TELEGRAM_RATE_LIMIT",
      retryAfter: method === "setMessageReaction" ? 30 : 4,
    });
  };
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(calls, 2);
  t.mock.timers.tick(5000);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(calls, 2);
  t.mock.timers.tick(25000);
  await f.service.feedback.process(f.channel.id, signal());
  assert.equal(calls, 4);
});
