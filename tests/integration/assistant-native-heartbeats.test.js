import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

const heartbeat = {
  enabled: true,
  interval: "4h",
  start: 8,
  end: 20,
  timeZone: "Europe/Berlin",
};
function setup(t, { capabilities = { memory: true, reminders: false } } = {}) {
  const f = channelFixture(t),
    id = f.channel.assistantId,
    jobs = new Map(),
    calls = [],
    injected = [],
    pushes = [];
  f.store.updateAssistant(id, { capabilities, heartbeat }, 1);
  f.assistants.admit = (fn) => fn();
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  f.assistants.runtime.client.call = async (method, input) => {
    calls.push({ method, input });
    if (method === "cron.list")
      return {
        jobs: [...jobs.values()].filter((j) => j.agentId === input.agentId),
        hasMore: false,
      };
    if (method === "cron.add") {
      const job = { ...input, id: `job-${calls.length}`, updatedAtMs: 1, state: {} };
      jobs.set(job.id, job);
      return { created: true, job };
    }
    if (method === "cron.update") {
      const j = { ...jobs.get(input.id), ...input.patch, updatedAtMs: 2 };
      jobs.set(j.id, j);
      return j;
    }
    if (method === "cron.remove") {
      jobs.delete(input.id);
      return { removed: true };
    }
    if (method === "chat.inject") {
      injected.push(input);
      return { ok: true, messageId: `m-${injected.length}` };
    }
    assert.fail(method);
  };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  f.assistants.reminders = reminders;
  const heartbeats = new NativeHeartbeats({
    reminders,
    notifications: { notify: async (input) => pushes.push(input) },
  });
  t.after(() => reminders.close());
  const save = (patch) =>
    f.store.updateAssistant(id, patch, f.store.getAssistant(id).revision);
  const deliver = async (binding, event) => {
    const { url, token } = await reminders.start();
    return fetch(`${url}/complete/${binding}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  };
  return {
    ...f,
    id,
    jobs,
    calls,
    injected,
    pushes,
    reminders,
    heartbeats,
    save,
    deliver,
  };
}
const added = (f) => f.calls.filter((c) => c.method === "cron.add");

test("an opted-in agent gets one check-in job in its conversation, reported to AgentPier", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  await f.heartbeats.sync(f.id);
  assert.equal(added(f).length, 1, "a repeated sync adds no second job");
  assert.equal(f.calls.filter((c) => c.method === "cron.update").length, 0);
  const job = [...f.jobs.values()][0];
  assert.equal(job.agentId, f.store.getAssistant(f.id).runtimeAgentId);
  assert.deepEqual(job.schedule, {
    kind: "cron",
    expr: "0 8,12,16 * * *",
    tz: "Europe/Berlin",
  });
  // The run reads the paired conversation and commits its result back into it.
  assert.equal(job.sessionTarget, "current");
  assert.equal(
    job.sessionKey,
    f.store.getConversation(f.channel.conversationId).runtimeSessionKey,
  );
  assert.equal(job.enabled, true);
  assert.equal(job.payload.kind, "agentTurn");
  // Full context: the agent's instructions and notes are part of the run.
  assert.equal(job.payload.lightContext, false);
  assert.match(job.payload.message, /NO_REPLY/);
  // Memory is read, never written, in an unattended run.
  assert.deepEqual(job.payload.toolsAllow, ["memory_search", "memory_get"]);
  assert.equal(job.delivery.mode, "announce");
  assert.equal(job.delivery.completionDestination.mode, "webhook");
  assert.match(
    job.delivery.completionDestination.to,
    /^http:\/\/127\.0\.0\.1:\d+\/complete\/[a-f0-9-]{36}$/,
  );
  // Heartbeat bindings never appear among reminders or routines.
  assert.deepEqual((await f.reminders.list(f.id)).reminders, []);
});

test("an agent without memory keeps no check-in job", async (t) => {
  const f = setup(t, { capabilities: { memory: false, reminders: false } });
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 0);
});

test("a new main chat moves the job to it", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const [old] = f.jobs.keys();
  const conversation = f.store.getConversation(f.channel.conversationId);
  f.store.db
    .prepare("UPDATE conversations SET body=? WHERE id=?")
    .run(
      JSON.stringify({ ...conversation, archivedAt: new Date().toISOString() }),
      conversation.id,
    );
  f.store.saveConversation({ assistantId: f.id, runtimeSessionKey: "session-2" });
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.has(old), false);
  assert.equal([...f.jobs.values()][0].sessionKey, "session-2");
});

test("changed settings update the job in place and switching off removes it", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const [first] = f.jobs.keys();
  f.save({ heartbeat: { ...heartbeat, interval: "daily", start: 9 } });
  await f.heartbeats.sync(f.id);
  assert.equal(added(f).length, 1);
  assert.deepEqual(f.jobs.get(first).schedule.expr, "0 9 * * *");
  const binding = f.reminders.bindings.list(f.id)[0];
  f.save({ heartbeat: { ...heartbeat, enabled: false } });
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.reminders.bindings.get(binding.id).state, "removed");
  assert.equal(
    (
      await f.deliver(binding.id, {
        jobId: first,
        runAtMs: 1,
        status: "ok",
        summary: "Late",
      })
    ).status,
    204,
  );
  assert.equal(f.service.outbox.all(f.channel.id).length, 0, "a removed job is mute");
});

test("only a check-in with content reaches the paired chat, plus a push notice", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const binding = f.reminders.bindings.list(f.id)[0];
  const event = (runAtMs, summary, status = "ok", deliveryStatus = "delivered") => ({
    jobId: binding.nativeId ?? f.reminders.bindings.get(binding.id).nativeId,
    runAtMs,
    status,
    summary,
    deliveryStatus,
  });
  for (const [n, summary] of [
    [1, "NO_REPLY"],
    [2, "  NO_REPLY\n"],
    [3, ""],
  ])
    assert.equal((await f.deliver(binding.id, event(n, summary))).status, 204);
  assert.equal((await f.deliver(binding.id, event(4, "Boom", "error"))).status, 204);
  // Sent only once OpenClaw committed it to the conversation, so a reply has context.
  for (const [n, status] of [
    [8, "not-delivered"],
    [9, "unknown"],
    [10, null],
  ])
    assert.equal(
      (await f.deliver(binding.id, event(n, "Not in the chat", "ok", status))).status,
      204,
    );
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  assert.equal(f.pushes.length, 0);
  // The model cannot choose a recipient: the text goes to the paired chat as is.
  const text = 'Your parcel arrives today. {"chatId": 999, "to": "@someone"}';
  assert.equal((await f.deliver(binding.id, event(5, text))).status, 204);
  assert.equal((await f.deliver(binding.id, event(5, text))).status, 204);
  const outbox = f.service.outbox.all(f.channel.id);
  assert.equal(outbox.length, 1, "a replayed run is delivered once");
  assert.equal(outbox[0].kind, "heartbeat");
  // Marked in the channel's language so the owner knows where it came from.
  const prefix = serverCatalogs[f.channel.language].assistants.heartbeatPrefix;
  assert.equal(outbox[0].text, `${prefix} ${text}`);
  assert.equal(outbox[0].chatId, f.channel.chatId);
  assert.equal(outbox[0].userId, f.channel.userId);
  assert.deepEqual(
    f.pushes.map((p) => [p.kind, p.assistantId]),
    [["agent-checkin", f.id]],
  );
  // Devices that show names and previews get the agent and the check-in; the paired
  // Telegram chat delivered it too, which devices may leave out.
  assert.equal(typeof f.pushes[0].label, "string");
  assert.equal(f.pushes[0].preview, text);
  assert.equal(f.pushes[0].telegram, true);
  assert.equal(
    (await f.deliver(binding.id, { ...event(6, "x"), jobId: "foreign" })).status,
    403,
  );
});

test("a paused or ineligible agent loses its job and pending check-ins stay unsent", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const binding = f.reminders.bindings.list(f.id)[0];
  const jobId = f.reminders.bindings.get(binding.id).nativeId;
  await f.deliver(binding.id, {
    jobId,
    runAtMs: 7,
    status: "ok",
    summary: "Hello",
    deliveryStatus: "delivered",
  });
  const [entry] = f.service.outbox.all(f.channel.id);
  assert.equal(f.heartbeats.acceptsDelivery(entry), true);
  // A blocked model connection pauses scheduling like reminders.
  f.heartbeats.blocked = () => true;
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.heartbeats.acceptsDelivery(entry), false);
  let sends = 0;
  f.client.call = async () => ({ message_id: ++sends, chat: { id: 42 } });
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 0);
  assert.equal(f.service.outbox.get(entry.id).state, "reviewed");
  f.heartbeats.blocked = () => false;
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 1, "unblocking schedules a fresh job");
});

test("an agent without Telegram or a chat gets its main chat opened for check-ins", async (t) => {
  const f = setup(t);
  const other = f.store.createAssistant({
    name: "Unpaired",
    model: { connectionId: "test", modelId: "fixture" },
    capabilities: { memory: true, reminders: false },
  });
  f.store.updateAssistant(other.id, { heartbeat }, other.revision);
  let opened = 0;
  f.assistants.mainConversation = async (id) => {
    opened++;
    return f.store.saveConversation({ assistantId: id, runtimeSessionKey: "other" });
  };
  await f.heartbeats.sync(other.id);
  await f.heartbeats.sync(other.id);
  assert.equal(opened, 1);
  assert.equal(added(f).length, 1);
  assert.equal(added(f)[0].input.sessionKey, "other");
  const [binding] = f.reminders.bindings.list(other.id);
  assert.equal(binding.telegram, null);
});

test("pairing changes move only the Telegram extra and never retire the job", async (t) => {
  const f = setup(t);
  await f.heartbeats.sync(f.id);
  const [first] = f.reminders.bindings.list(f.id);
  const [jobId] = f.jobs.keys();
  // Starting a new pairing disables the chat: the job keeps running in the main chat.
  const channel = f.service.store.get(f.channel.id);
  const { code } = await f.service.pair(channel.id, channel.revision);
  await f.service.heartbeatSync;
  assert.deepEqual([...f.jobs.keys()], [jobId]);
  assert.equal(f.reminders.bindings.get(first.id).state, "bound");
  assert.equal(f.reminders.bindings.get(first.id).telegram, null);
  // Completing it with a different chat sends later check-ins there too.
  await f.service.ingress.receive(channel.id, [
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: 77, type: "private" },
        from: { id: 77, is_bot: false },
        text: `/start ${code}`,
      },
    },
  ]);
  await f.service.heartbeatSync;
  assert.deepEqual([...f.jobs.keys()], [jobId]);
  assert.equal(f.reminders.bindings.get(first.id).telegram.chatId, "77");
  await f.service.disconnect(channel.id, f.service.store.get(channel.id).revision);
  await f.service.heartbeatSync;
  assert.deepEqual([...f.jobs.keys()], [jobId]);
  assert.equal(f.reminders.bindings.get(first.id).state, "bound");
  assert.equal(added(f).length, 1);
  assert.equal(f.calls.filter((c) => c.method === "cron.remove").length, 0);
});

test("a lost creation acknowledgement is adopted by delivery and never orphaned", async (t) => {
  const f = setup(t);
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    const result = await call(method, input);
    if (method === "cron.add") throw Object.assign(Error(), { code: "CLOSED" });
    return result;
  };
  await assert.rejects(f.heartbeats.sync(f.id), { status: 503 });
  f.assistants.runtime.client.call = call;
  const [binding] = f.reminders.bindings.list(f.id);
  assert.equal(binding.state, "unknown");
  const [jobId] = f.jobs.keys();
  // The run's completion adopts the job by its declaration instead of refusing it.
  const response = await f.deliver(binding.id, {
    jobId,
    runAtMs: 9,
    status: "ok",
    summary: "Parcel arrived",
    deliveryStatus: "delivered",
  });
  assert.equal(response.status, 204);
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 1, "the adopted job is kept, not duplicated");
});

test("an unconfirmed binding whose job is not listed yet stays tracked", async (t) => {
  const f = setup(t);
  const call = f.assistants.runtime.client.call;
  let hidden = null;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.add") {
      hidden = input;
      throw Object.assign(Error(), { code: "CLOSED" });
    }
    return call(method, input);
  };
  await assert.rejects(f.heartbeats.sync(f.id), { status: 503 });
  f.assistants.runtime.client.call = call;
  // Switching off before the submission surfaces must not forget the binding.
  f.save({ heartbeat: { ...heartbeat, enabled: false } });
  await f.heartbeats.sync(f.id);
  const [binding] = f.reminders.bindings.list(f.id);
  assert.notEqual(binding.state, "removed");
  // The late job surfaces and the next sync removes it.
  await call("cron.add", hidden);
  await f.heartbeats.sync(f.id);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.reminders.bindings.get(binding.id).state, "removed");
});
