import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { ChannelLedger } from "../../server/features/assistant-channels/channel-ledger.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
const en = serverCatalogs.en.assistants;
const run = (f) => f.service.process(f.channel.id, new AbortController().signal);
// Fake Telegram Bot API: records every call, serves queued updates and confirms
// sends unless `fails` marks a send as lost after acceptance.
function telegram(f, fails = () => false) {
  const calls = [],
    updates = [];
  f.client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "getUpdates") return updates.splice(0);
    if (method === "sendMessage") {
      if (fails(params))
        throw Object.assign(Error("lost"), { code: "DELIVERY_UNCERTAIN" });
      return { message_id: 500 + calls.length, chat: { id: 42 } };
    }
    return true;
  };
  return {
    calls,
    updates,
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params.text),
    answers: () => calls.filter((c) => c.method === "answerCallbackQuery"),
  };
}
function replies(f) {
  const texts = new Map();
  f.assistants.history = async () => ({
    stale: false,
    messages: [...texts].map(([runId, text]) => ({ role: "assistant", text, runId })),
  });
  return texts;
}
const complete = (f, entryId) => {
  const entry = f.service.ledger.get(entryId);
  f.assistants.ledger.transition(entry.attemptId, "completed");
  return entry.attemptId;
};
test("a completed run without text is released after a grace period and stays reviewable", async (t) => {
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const f = channelFixture(t, { now: () => clock, language: () => "en" });
  const tg = telegram(f),
    id = f.channel.id;
  await f.service.ingress.receive(id, [
    telegramMessage(1, "First"),
    telegramMessage(2, "Second"),
  ]);
  await run(f);
  const [first, second] = f.service.ledger.list(id);
  assert.equal(f.service.ledger.get(first.id).state, "running");
  complete(f, first.id);
  await run(f);
  clock += 59_000;
  await run(f);
  assert.equal(f.service.ledger.get(first.id).state, "running");
  assert.equal(f.sent.length, 1);
  clock += 1_000;
  await run(f);
  assert.equal(f.service.ledger.get(first.id).state, "reply_unavailable");
  await run(f);
  await run(f);
  assert.deepEqual(tg.sent(), [en.telegramReplyUnavailable]);
  assert.deepEqual(
    f.sent.map((input) => input.text),
    ["First", "Second"],
  );
  assert.equal(f.service.ledger.get(second.id).state, "running");
  await f.service.recoverInput(id, first.id, "review");
  assert.equal(f.service.ledger.get(first.id).state, "reviewed");
});
test("an uncertain delivery moves to review, is announced once and is never resent", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const tg = telegram(f, (params) => params.text === "First reply"),
    texts = replies(f),
    id = f.channel.id;
  await f.service.ingress.receive(id, [
    telegramMessage(1, "First"),
    telegramMessage(2, "Second"),
  ]);
  await run(f);
  const [first, second] = f.service.ledger.list(id);
  texts.set(complete(f, first.id), "First reply");
  await run(f);
  assert.equal(f.service.ledger.get(first.id).state, "delivery_uncertain");
  for (let n = 0; n < 3; n++) await run(f);
  assert.equal(f.sent.length, 2);
  texts.set(complete(f, second.id), "Second reply");
  for (let n = 0; n < 3; n++) await run(f);
  assert.deepEqual(tg.sent(), [
    "First reply",
    en.telegramInputNeedsReview,
    "Second reply",
  ]);
  assert.equal(f.service.ledger.get(first.id).state, "delivery_uncertain");
  assert.equal(f.service.ledger.get(second.id).state, "delivered");
  const listed = f.service.list().channels[0].inputs;
  assert.equal(listed.find((e) => e.id === first.id).needsReview, true);
  assert.equal(listed.find((e) => e.id === second.id).needsReview, false);
});
test("a failed transcription moves to review without holding later messages", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const tg = telegram(f),
    id = f.channel.id;
  const voice = telegramMessage(1);
  delete voice.message.text;
  voice.message.voice = {
    file_id: "voice-file",
    duration: 3,
    file_size: 10,
    mime_type: "audio/ogg",
  };
  await f.service.ingress.receive(id, [voice, telegramMessage(2, "Typed instead")]);
  for (let n = 0; n < 3; n++) await run(f);
  const [spoken] = f.service.ledger.list(id);
  assert.equal(f.service.ledger.get(spoken.id).state, "transcription_failed");
  assert.deepEqual(
    f.sent.map((input) => input.text),
    ["Typed instead"],
  );
  assert.deepEqual(tg.sent(), [en.telegramInputNeedsReview]);
});
test("an unknown model outcome is announced once and released after review in chat", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const tg = telegram(f),
    id = f.channel.id;
  await f.service.ingress.receive(id, [
    telegramMessage(1, "First"),
    telegramMessage(2, "Second"),
  ]);
  await run(f);
  const [first, second] = f.service.ledger.list(id);
  const attemptId = f.service.ledger.get(first.id).attemptId;
  f.assistants.ledger.transition(attemptId, "uncertain");
  for (let n = 0; n < 3; n++) await run(f);
  assert.equal(f.service.ledger.get(first.id).state, "model_uncertain");
  assert.equal(f.service.ledger.get(second.id).state, "queued");
  f.assistants.ledger.review(attemptId);
  for (let n = 0; n < 3; n++) await run(f);
  assert.equal(f.service.ledger.get(first.id).state, "model_reviewed");
  assert.equal(f.service.ledger.get(second.id).state, "running");
  assert.deepEqual(tg.sent(), [en.telegramInputNeedsReview]);
  await f.service.recoverInput(id, first.id, "review");
  assert.equal(f.service.ledger.get(first.id).state, "reviewed");
});
function approvalFixture(t, decide) {
  const f = channelFixture(t, { language: () => "en" });
  f.assistants.teams = { decide, store: { list: () => [], find: () => null } };
  const entry = f.service.outbox.enqueue({
    key: "team-approval:team",
    source: { channelId: f.channel.id, chatId: "42", userId: "42" },
    teamId: "team",
    kind: "team-approval",
    text: "Approve the team?",
    actions: [{ decision: "approve", label: "Approve", proposalId: "team", revision: 1 }],
  });
  return { f, tg: telegram(f), entry };
}
const callback = (updateId, data, user = 42) => ({
  update_id: updateId,
  callback_query: {
    id: `callback-${updateId}`,
    data,
    from: { id: user, is_bot: false },
    message: { message_id: 10, chat: { id: 42, type: "private" } },
  },
});
test("a failing decision is answered, acknowledged and recorded without refetching", async (t) => {
  let decisions = 0;
  const { f, tg, entry } = approvalFixture(t, () => {
    decisions++;
    throw Object.assign(Error("database locked"), { status: 500 });
  });
  const id = f.channel.id;
  tg.updates.push(callback(5, entry.actions[0].handle));
  await f.service.ingress.poll(id);
  assert.equal(f.service.store.offset(id), 6);
  assert.deepEqual(
    tg.answers().map((c) => c.params),
    [{ callback_query_id: "callback-5", text: en.teamDecisionFailed }],
  );
  assert.equal(f.service.outbox.get(entry.id).diagnostic, "DECISION_FAILED");
  await f.service.ingress.poll(id);
  const polls = tg.calls.filter((c) => c.method === "getUpdates");
  assert.equal(polls.at(-1).params.offset, 6);
  assert.equal(decisions, 1);
});
test("a callback failing before its decision is still answered and reported", async (t) => {
  const { f, tg } = approvalFixture(t, () => assert.fail("must not decide"));
  const id = f.channel.id;
  f.service.outbox.all = () => {
    throw Error("database locked");
  };
  tg.updates.push(callback(7, "any-handle"));
  await f.service.ingress.poll(id);
  assert.equal(f.service.store.offset(id), 8);
  assert.deepEqual(
    tg.answers().map((c) => c.params),
    [{ callback_query_id: "callback-7", text: en.teamDecisionFailed }],
  );
  assert.equal(f.service.store.get(id).diagnostic, "CALLBACK_FAILED");
});
test("expired, unknown and foreign callbacks are always answered", async (t) => {
  const { f, tg, entry } = approvalFixture(t, () => assert.fail("must not decide"));
  const id = f.channel.id;
  const expired = f.service.outbox.transition(entry.id, entry.state, {
    actions: entry.actions.map((action) => ({ ...action, expiresAt: 1 })),
  });
  tg.updates.push(
    callback(1, expired.actions[0].handle),
    callback(2, "unknown-handle"),
    callback(3, expired.actions[0].handle, 43),
  );
  await f.service.ingress.poll(id);
  assert.deepEqual(
    tg.answers().map((c) => c.params.callback_query_id),
    ["callback-1", "callback-2", "callback-3"],
  );
  assert.equal(f.service.store.offset(id), 4);
});
test("a full queue acknowledges the message and tells the user once", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const tg = telegram(f),
    id = f.channel.id;
  await f.service.ingress.receive(
    id,
    Array.from({ length: 200 }, (_, n) => telegramMessage(n + 1, `Message ${n + 1}`)),
  );
  tg.updates.push(telegramMessage(201, "One more"), telegramMessage(202, "And another"));
  await f.service.ingress.poll(id);
  assert.equal(f.service.store.offset(id), 203);
  const active = f.service.ledger.active(id);
  assert.equal(active.length, 200);
  assert.ok(!active.some((entry) => entry.messageId > 200));
  assert.equal(f.service.store.get(id).diagnostic, "CHANNEL_QUEUE_FULL");
  const notices = () => f.service.outbox.all(id).filter((e) => e.kind === "queue-full");
  assert.equal(notices().length, 1);
  await f.service.teamOutbox.process(id, new AbortController().signal);
  assert.deepEqual(tg.sent(), [en.telegramQueueFull]);
  tg.updates.push(telegramMessage(203, "Still full"));
  await f.service.ingress.poll(id);
  assert.equal(notices().length, 1);
  // The queue drains and fills again: a new episode earns one new notice.
  f.service.ledger.patch(active[0].id, { state: "cancelled" });
  tg.updates.push(telegramMessage(204, "Fits"), telegramMessage(205, "Full again"));
  await f.service.ingress.poll(id);
  assert.ok(f.service.ledger.active(id).some((entry) => entry.messageId === 204));
  assert.equal(notices().length, 2);
});
test("a broken team record does not stop other notifications or the inbox", async (t) => {
  const f = channelFixture(t);
  const tg = telegram(f),
    id = f.channel.id,
    records = new Map();
  const origin = { kind: "telegram", channelId: id, chatId: "42", userId: "42" };
  const teams = [
    {
      id: "broken",
      origin,
      phase: "awaiting_approval",
      objective: "Broken",
      revision: 1,
    },
    {
      id: "working",
      origin,
      phase: "awaiting_approval",
      objective: "Working",
      revision: 1,
      members: [{ name: "Planner", role: "Plan", assignment: "Plan it" }],
    },
  ];
  f.assistants.teams = {
    store: {
      list: () => teams,
      get: (teamId) => teams.find((team) => team.id === teamId),
      find: (key) => records.get(key) || teams.find((team) => team.id === key) || null,
      insert: (record) => records.set(record.id, record),
      members: () => [],
    },
  };
  await f.service.ingress.receive(id, [telegramMessage(1)]);
  await run(f);
  assert.equal(tg.sent().length, 1);
  assert.ok(tg.sent()[0].includes("Working"));
  assert.equal(f.sent.length, 1);
  const diagnostic = () => f.service.list().channels[0].notificationDiagnostic;
  assert.equal(diagnostic(), "TEAM_NOTIFICATION_FAILED");
  teams[0].members = [{ name: "Fixer", role: "Fix", assignment: "Fix it" }];
  await run(f);
  assert.equal(diagnostic(), null);
});
const reset = (updateId, messageId, text) => {
  const update = telegramMessage(updateId, text);
  update.message.message_id = messageId;
  return update;
};
test("update ids restarting after a quiet week are processed and deduplicated by message", async (t) => {
  const f = channelFixture(t);
  const tg = telegram(f),
    id = f.channel.id;
  tg.updates.push(telegramMessage(999, "Before the quiet week"));
  await f.service.ingress.poll(id);
  assert.equal(f.service.store.offset(id), 1000);
  tg.updates.push(
    reset(5, 1000, "After the quiet week"),
    reset(6, 1000, "After the quiet week"),
  );
  await f.service.ingress.poll(id);
  assert.equal(f.service.store.offset(id), 7);
  tg.updates.push(reset(999, 1001, "Reused update id"));
  await f.service.ingress.poll(id);
  assert.equal(f.service.store.offset(id), 1000);
  assert.deepEqual(
    tg.calls.filter((c) => c.method === "getUpdates").map((c) => c.params.offset),
    [0, 1000, 7],
  );
  assert.deepEqual(
    f.service.ledger.list(id).map((entry) => entry.text),
    ["Before the quiet week", "After the quiet week", "Reused update id"],
  );
});
test("an inbox keyed by update id is migrated without losing arrival order", (t) => {
  const f = channelFixture(t);
  const db = f.service.store.db,
    id = f.channel.id;
  db.exec(`DROP TABLE channel_inbox;
    CREATE TABLE channel_inbox(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), update_id INTEGER NOT NULL, message_id INTEGER NOT NULL, body TEXT NOT NULL, chat_id TEXT NOT NULL, UNIQUE(channel_id,update_id), UNIQUE(channel_id,chat_id,message_id));`);
  const insert = db.prepare("INSERT INTO channel_inbox VALUES(?,?,?,?,?,?)");
  for (const [entryId, updateId] of [
    ["later", 20],
    ["earlier", 10],
  ])
    insert.run(
      entryId,
      id,
      updateId,
      updateId,
      JSON.stringify({ id: entryId, channelId: id, updateId, state: "delivered" }),
      "42",
    );
  const ledger = new ChannelLedger(db);
  ledger.accept(f.channel, reset(10, 30, "Reused"));
  assert.deepEqual(
    ledger.list(id).map((entry) => (entry.id.length > 10 ? "new" : entry.id)),
    ["earlier", "later", "new"],
  );
});
