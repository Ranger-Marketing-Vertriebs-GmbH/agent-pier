import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";

// AGENTPIER-141: routines, reminders and check-ins deliver to the agent's main chat
// (its one AgentPier conversation) with a push notice; Telegram is an optional extra.
const reminderInput = {
  clientRequestId: "reminder-1",
  name: "Water",
  message: "Water the plants.",
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Berlin" },
};
const heartbeat = {
  enabled: true,
  interval: "4h",
  start: 8,
  end: 20,
  timeZone: "Europe/Berlin",
};
const nativeId = (f, id) => f.reminders.bindings.get(id).nativeId;

test("without Telegram a routine is created, paused, resumed and run in the main chat", async (t) => {
  const f = routineFixture(t, { paired: false });
  const routine = await f.routines.create(f.id, f.input);
  assert.equal(routine.status, "ready");
  assert.equal(routine.telegram, false);
  const job = f.jobs.get(nativeId(f, routine.id));
  assert.equal(job.sessionTarget, "current");
  assert.equal(job.sessionKey, "session");
  assert.equal(job.delivery.mode, "announce");
  assert.equal(job.delivery.completionDestination.mode, "webhook");
  const binding = f.reminders.bindings.get(routine.id);
  assert.deepEqual(binding.target, {
    conversationId: f.channel.conversationId,
    sessionKey: "session",
  });
  const paused = await f.routines.update(f.id, routine.id, {
    enabled: false,
    revision: routine.revision,
  });
  const resumed = await f.routines.update(f.id, routine.id, {
    enabled: true,
    revision: paused.revision,
  });
  assert.equal(resumed.enabled, true);
  const event = await f.routines.create(f.id, {
    ...f.input,
    clientRequestId: "event-1",
    trigger: { kind: "event" },
  });
  assert.equal(
    (await f.routines.trigger(f.id, event.id, { eventId: "owner:1" })).status,
    "queued",
  );
  await f.reminders.complete(routine.id, {
    jobId: job.id,
    runAtMs: 1000,
    status: "ok",
    summary: "Lentil soup today.",
    deliveryStatus: "delivered",
  });
  assert.equal(f.service.outbox.all(f.channel.id).length, 0, "nothing for Telegram");
  const [result] = f.routines.results.forConversation(f.channel.conversationId);
  assert.equal(result.text, "Lentil soup today.");
  assert.equal(result.committed, true);
  assert.deepEqual(f.pushes, [
    {
      kind: "agent-routine",
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      eventId: `routine-1000-${routine.id}`,
    },
  ]);
  // A replayed completion sends no second notice.
  await f.reminders.complete(routine.id, {
    jobId: job.id,
    runAtMs: 1000,
    status: "ok",
    summary: "Lentil soup today.",
    deliveryStatus: "delivered",
  });
  assert.equal(f.pushes.length, 1);
});

test("without Telegram a reminder is shown in the main chat with a push, failures too", async (t) => {
  const f = routineFixture(t, { paired: false });
  const reminder = await f.reminders.create(f.id, reminderInput);
  assert.equal(reminder.status, "ready");
  const jobId = nativeId(f, reminder.id);
  // A reminder stays a tool-less verbatim run.
  assert.deepEqual(f.jobs.get(jobId).payload.toolsAllow, []);
  const paused = await f.reminders.update(f.id, reminder.id, {
    enabled: false,
    revision: reminder.revision,
  });
  const resumed = await f.reminders.update(f.id, reminder.id, {
    enabled: true,
    revision: paused.revision,
  });
  assert.equal(resumed.enabled, true);
  await f.reminders.complete(reminder.id, {
    jobId,
    runAtMs: 10,
    status: "ok",
    summary: "Water the plants.",
    // The webhook delivered it; the conversation was not written by OpenClaw.
    deliveryStatus: "delivered",
  });
  await f.reminders.complete(reminder.id, { jobId, runAtMs: 20, status: "error" });
  const results = f.routines.results.forConversation(f.channel.conversationId);
  assert.deepEqual(
    results.map((r) => [r.kind, r.status, r.committed ?? null, r.text ?? null]),
    [
      ["reminder", "ok", false, "Water the plants."],
      ["reminder", "error", null, null],
    ],
  );
  assert.deepEqual(
    f.pushes.map((p) => [p.kind, p.conversationId]),
    [
      ["agent-routine", f.channel.conversationId],
      ["agent-routine", f.channel.conversationId],
    ],
  );
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
});

test("a routine without a main chat yet opens it before its job is added", async (t) => {
  const f = routineFixture(t, { paired: false });
  const old = f.store.getConversation(f.channel.conversationId);
  f.store.db
    .prepare("UPDATE conversations SET body=? WHERE id=?")
    .run(JSON.stringify({ ...old, archivedAt: new Date().toISOString() }), old.id);
  let opened = 0;
  f.assistants.mainConversation = async (id) => {
    opened++;
    return f.store.saveConversation({ assistantId: id, runtimeSessionKey: "fresh" });
  };
  const routine = await f.routines.create(f.id, f.input);
  assert.equal(opened, 1);
  assert.equal(f.jobs.get(nativeId(f, routine.id)).sessionKey, "fresh");
});

test("Telegram is an optional extra per item and needs a paired chat", async (t) => {
  const f = routineFixture(t);
  const quiet = await f.routines.create(f.id, f.input);
  const loud = await f.routines.create(f.id, {
    ...f.input,
    clientRequestId: "routine-2",
    telegram: true,
  });
  assert.deepEqual([quiet.telegram, loud.telegram], [false, true]);
  for (const [item, runAtMs] of [
    [quiet, 1],
    [loud, 2],
  ])
    await f.reminders.complete(item.id, {
      jobId: nativeId(f, item.id),
      runAtMs,
      status: "ok",
      summary: `Result ${runAtMs}`,
      deliveryStatus: "delivered",
    });
  const outbox = f.service.outbox.all(f.channel.id);
  assert.deepEqual(
    outbox.map((e) => e.text),
    ["Result 2"],
  );
  assert.equal(f.routines.results.forConversation(f.channel.conversationId).length, 2);
  assert.equal(f.pushes.length, 2);
  // Switching Telegram off holds back a queued delivery; chat and push go on.
  const off = await f.routines.update(f.id, loud.id, {
    telegram: false,
    revision: loud.revision,
  });
  assert.equal(off.telegram, false);
  assert.equal(f.reminders.acceptsDelivery(outbox[0]), false);
  assert.equal(off.enabled, true, "the routine keeps running");
  const on = await f.routines.update(f.id, quiet.id, {
    telegram: true,
    revision: quiet.revision,
  });
  assert.equal(on.telegram, true);
  // Without a paired chat Telegram cannot be switched on.
  f.service.store.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  await assert.rejects(
    f.routines.update(f.id, loud.id, { telegram: true, revision: off.revision }),
    { status: 409, key: "reminderChannelRequired" },
  );
  await assert.rejects(f.reminders.create(f.id, { ...reminderInput, telegram: true }), {
    status: 409,
    key: "reminderChannelRequired",
  });
});

test("unpairing Telegram keeps routines and reminders scheduled", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, { ...f.input, telegram: true });
  const reminder = await f.reminders.create(f.id, { ...reminderInput, telegram: true });
  await f.service.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  await f.service.routineSync;
  assert.equal(f.jobs.size, 2);
  assert.equal(f.calls.filter((c) => c.method === "cron.remove").length, 0);
  const [listed] = (await f.routines.list(f.id)).routines;
  assert.equal(listed.enabled, true);
  // The run still reaches the chat and a push notice; the unpaired chat is skipped.
  await f.reminders.complete(reminder.id, {
    jobId: nativeId(f, reminder.id),
    runAtMs: 5,
    status: "ok",
    summary: "Water the plants.",
  });
  assert.equal(f.routines.results.forConversation(f.channel.conversationId).length, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(routine.telegram, true);
});

test("existing Telegram routines and reminders migrate with Telegram delivery kept on", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const reminder = await f.reminders.create(f.id, reminderInput);
  // Bindings as they were stored before chat delivery: the Telegram chat in `source`.
  for (const item of [routine, reminder]) {
    const {
      target: _target,
      telegram: _telegram,
      ...rest
    } = f.reminders.bindings.get(item.id);
    f.reminders.bindings.db
      .prepare("UPDATE assistant_reminder_bindings SET body=? WHERE id=?")
      .run(
        JSON.stringify({
          ...rest,
          source: {
            assistantId: f.id,
            channelId: f.channel.id,
            chatId: f.channel.chatId,
            userId: f.channel.userId,
          },
        }),
        item.id,
      );
  }
  // The routine's job ran isolated (no conversation then): it moves to the chat.
  const jobId = nativeId(f, routine.id);
  const job = f.jobs.get(jobId);
  f.jobs.set(jobId, {
    ...job,
    sessionTarget: "isolated",
    sessionKey: undefined,
    delivery: { mode: "webhook", to: job.delivery.completionDestination.to },
  });
  await f.routines.reconcile();
  assert.equal(f.jobs.get(jobId).sessionTarget, "current");
  assert.equal(f.jobs.get(jobId).sessionKey, "session");
  assert.equal(f.reminders.bindings.get(routine.id).target.sessionKey, "session");
  const listed = await f.routines.list(f.id);
  assert.equal(listed.routines[0].telegram, true);
  assert.equal((await f.reminders.list(f.id)).reminders[0].telegram, true);
  await f.reminders.complete(reminder.id, {
    jobId: nativeId(f, reminder.id),
    runAtMs: 7,
    status: "ok",
    summary: "Water the plants.",
  });
  const [entry] = f.service.outbox.all(f.channel.id);
  assert.equal(entry.text, "Water the plants.");
  assert.equal(entry.chatId, f.channel.chatId);
  assert.equal(f.reminders.acceptsDelivery(entry), true);
  assert.equal(f.routines.results.forConversation(f.channel.conversationId).length, 1);
});

test("check-ins run in the main chat without Telegram and notify with a push", async (t) => {
  const f = routineFixture(t, { paired: false });
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: false }, heartbeat },
    f.store.getAssistant(f.id).revision,
  );
  const pushes = [];
  const heartbeats = new NativeHeartbeats({
    reminders: f.reminders,
    notifications: { notify: async (input) => pushes.push(input) },
  });
  await heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 1);
  const [job] = f.jobs.values();
  assert.equal(job.sessionTarget, "current");
  assert.equal(job.sessionKey, "session");
  const [binding] = f.reminders.bindings.list(f.id);
  const event = {
    jobId: job.id,
    runAtMs: 3,
    status: "ok",
    summary: "Your parcel arrives today.",
    deliveryStatus: "delivered",
  };
  await f.reminders.complete(binding.id, event);
  await f.reminders.complete(binding.id, event);
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  assert.deepEqual(pushes, [
    {
      kind: "agent-checkin",
      assistantId: f.id,
      conversationId: f.channel.conversationId,
      eventId: `heartbeat-3-${binding.id}`,
    },
  ]);
  const [result] = f.routines.results.forConversation(f.channel.conversationId);
  assert.deepEqual([result.kind, result.committed], ["heartbeat", true]);
  // Pairing later adds Telegram delivery without moving or retiring the job.
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, enabled: true }, channel.revision);
  await heartbeats.sync(f.id);
  assert.equal(f.calls.filter((c) => c.method === "cron.remove").length, 0);
  assert.equal(f.jobs.size, 1);
  await f.reminders.complete(binding.id, { ...event, runAtMs: 4 });
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  // The owner may keep check-ins out of Telegram.
  f.store.updateAssistant(
    f.id,
    { heartbeat: { ...heartbeat, telegram: false } },
    f.store.getAssistant(f.id).revision,
  );
  await heartbeats.sync(f.id);
  await f.reminders.complete(binding.id, { ...event, runAtMs: 5 });
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  assert.equal(pushes.length, 3);
});

test("an agent creates a routine from its web chat without Telegram", async (t) => {
  const f = routineFixture(t, { paired: false });
  f.assistants.teams = { store: { context: () => ({ kind: "owner" }) } };
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "turn-1",
    text: "Plan my meals every morning.",
  });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  const routine = await f.routines.invoke(
    { attemptId: attempt.id, toolCallId: "call-1", assertCurrent() {} },
    {
      action: "create",
      name: f.input.name,
      prompt: f.input.prompt,
      trigger: f.input.trigger,
    },
  );
  assert.equal(routine.status, "ready");
  assert.equal(routine.telegram, false);
  assert.equal(f.jobs.get(nativeId(f, routine.id)).sessionKey, "session");
});

test("queued Telegram output only goes to the chat a binding delivers to now", async (t) => {
  const f = routineFixture(t);
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: true }, heartbeat },
    f.store.getAssistant(f.id).revision,
  );
  const heartbeats = new NativeHeartbeats({ reminders: f.reminders });
  const routine = await f.routines.create(f.id, { ...f.input, telegram: true });
  await heartbeats.sync(f.id);
  const checkIn = f.reminders.bindings.list(f.id).find((b) => b.kind === "heartbeat");
  await f.reminders.complete(routine.id, {
    jobId: nativeId(f, routine.id),
    runAtMs: 1,
    status: "ok",
    summary: "Routine result",
    deliveryStatus: "delivered",
  });
  await f.reminders.complete(checkIn.id, {
    jobId: nativeId(f, checkIn.id),
    runAtMs: 2,
    status: "ok",
    summary: "Check-in result",
    deliveryStatus: "delivered",
  });
  const [queued, queuedCheckIn] = f.service.outbox.all(f.channel.id);
  assert.equal(f.reminders.acceptsDelivery(queued), true);
  assert.equal(heartbeats.acceptsDelivery(queuedCheckIn), true);
  // Re-paired with another chat: the queued output is not sent to it.
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, chatId: "77", userId: "77" }, channel.revision);
  const off = await f.routines.update(f.id, routine.id, {
    telegram: false,
    revision: routine.revision,
  });
  await f.routines.update(f.id, routine.id, { telegram: true, revision: off.revision });
  await heartbeats.sync(f.id);
  assert.equal(f.reminders.bindings.get(routine.id).telegram.chatId, "77");
  assert.equal(f.reminders.acceptsDelivery(queued), false);
  assert.equal(heartbeats.acceptsDelivery(queuedCheckIn), false);
});
