import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { importOpenClawExports } from "./openclaw-dist-exports.js";
import { channelFixture } from "./assistant-channel-fixture.js";
import { assistantRoutineModel } from "./assistant-routine-model.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";

// Pinned package internals, never copied or patched. The public wrapper launches
// this process with a disposable HOME and the runtime's own Node executable.
const {
  computeJobNextRunAtMs: nextRun,
  computeJobPreviousRunAtOrBeforeMs: previousRun,
  CronService,
} = await importOpenClawExports(
  path.join(process.env.AGENTPIER_ASSISTANT_ROUTINE_RUNTIME, "app/node_modules/openclaw"),
  ["computeJobNextRunAtMs", "computeJobPreviousRunAtOrBeforeMs", "CronService"],
);
const timestamp = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const scheduleJob = (tz, expr = "30 2 * * *") => ({
  id: "timezone-qualification",
  enabled: true,
  schedule: { kind: "cron", expr, tz, staggerMs: 0 },
  state: {},
});

test("native cron skips nonexistent Berlin and New York spring times", () => {
  for (const [tz, before, after] of [
    ["Europe/Berlin", "2026-03-28T01:30:00Z", "2026-03-30T00:30:00.000Z"],
    ["America/New_York", "2026-03-07T07:30:00Z", "2026-03-09T06:30:00.000Z"],
  ]) {
    assert.equal(iso(nextRun(scheduleJob(tz), timestamp(before))), after);
  }
});

test("native cron selects only the first repeated autumn wall-clock time", () => {
  for (const [tz, expr, before, first, after] of [
    [
      "Europe/Berlin",
      "30 2 * * *",
      "2026-10-24T00:30:00Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ],
    [
      "America/New_York",
      "30 1 * * *",
      "2026-10-31T05:30:00Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ],
  ]) {
    const job = scheduleJob(tz, expr);
    assert.equal(iso(nextRun(job, timestamp(before))), first);
    assert.equal(iso(nextRun(job, timestamp(first))), after);
    assert.equal(iso(previousRun(job, timestamp(first))), first);
  }
});

test("explicit timezone stays authoritative with a UTC host and absolute timestamps", () => {
  const before = timestamp("2026-03-29T00:00:00Z");
  assert.equal(
    iso(nextRun(scheduleJob("Europe/Berlin", "0 9 * * *"), before)),
    "2026-03-29T07:00:00.000Z",
  );
  assert.equal(
    iso(nextRun(scheduleJob("Asia/Kolkata", "0 9 * * *"), before)),
    "2026-03-29T03:30:00.000Z",
  );
  const job = {
    ...scheduleJob("UTC"),
    schedule: {
      kind: "at",
      at: "2026-10-25T02:30:00+01:00",
    },
  };
  assert.equal(iso(nextRun(job, before)), "2026-10-25T01:30:00.000Z");
});

async function fixture(t, { skipMissedJobs = false } = {}) {
  const f = channelFixture(t);
  const model = await assistantRoutineModel();
  const id = f.channel.assistantId;
  const events = [],
    executions = [],
    deliveries = [];
  let now = timestamp("2027-03-01T12:00:00Z"),
    native,
    reminders;
  const timers = new Map();
  f.store.updateAssistant(id, { capabilities: { memory: false, reminders: true } }, 1);
  f.assistants.admit = (fn) => Promise.resolve().then(fn);
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  fs.writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      agents: { list: [{ id: f.store.getAssistant(id).runtimeAgentId }] },
    }),
  );
  const scheduler = {
    now: () => now,
    signal: new AbortController().signal,
    schedule: (timer) => {
      timers.set(timer.id, timer);
      return { cancel: () => timers.delete(timer.id) };
    },
  };
  const makeNative = () =>
    new CronService({
      scheduler,
      nowMs: () => now,
      cronEnabled: true,
      cronConfig: skipMissedJobs ? { skipMissedJobs: true } : {},
      storePath: path.join(f.dataDir, "native-cron", "jobs.json"),
      defaultAgentId: f.store.getAssistant(id).runtimeAgentId,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      onEvent: (event) => events.push(event),
      runIsolatedAgentJob: async ({ job, message, onExecutionStarted }) => {
        onExecutionStarted?.();
        executions.push(job.id);
        const response = await fetch(`${model.url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: message }] }),
        });
        assert.ok((await response.text()).includes("A useful assistant reply."));
        return { status: "ok", summary: "A useful assistant reply." };
      },
    });
  native = makeNative();
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.add") return { job: await native.add(input) };
    if (method === "cron.list")
      return {
        jobs: await native.list({ includeDisabled: true }),
        hasMore: false,
      };
    if (method === "cron.update") return native.update(input.id, input.patch);
    if (method === "cron.remove") return native.remove(input.id);
    assert.fail(method);
  };
  const openReminders = () => {
    reminders = new NativeReminders({
      assistants: f.assistants,
      channels: f.service,
      dataDir: f.dataDir,
    });
    f.assistants.reminders = reminders;
    return new NativeRoutines({ reminders });
  };
  const routines = openReminders();
  f.client.call = async (method, input) => {
    assert.equal(method, "sendMessage");
    deliveries.push(input);
    return { message_id: deliveries.length, chat: { id: 42 } };
  };
  t.after(async () => {
    native.stop();
    await reminders.close();
    await model.close();
  });
  return {
    ...f,
    id,
    routines,
    events,
    executions,
    deliveries,
    get native() {
      return native;
    },
    get reminders() {
      return reminders;
    },
    get now() {
      return now;
    },
    advance: (ms) => {
      now += ms;
    },
    restart: async () => {
      native.stop();
      await reminders.close();
      openReminders();
      native = makeNative();
      await native.start();
    },
    tick: async () => {
      const timer = [...timers.values()].find((entry) => entry.id.endsWith(":due"));
      assert.ok(timer, "native scheduler must have armed its due timer");
      await timer.run();
    },
    deliver: async () => {
      for (const event of events.filter((entry) => entry.action === "finished")) {
        const binding = reminders.bindings
          .list(id)
          .find((b) => b.nativeId === event.jobId);
        await reminders.complete(binding.id, event);
      }
      for (const entry of f.service.outbox.pending(f.channel.id)) {
        assert.equal(entry.state, "outbound");
        await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
      }
    },
  };
}

test("native restart coalesces thirty days of recurring misses and delivers once", async (t) => {
  const f = await fixture(t);
  const routine = await f.routines.create(f.id, {
    clientRequestId: "downtime-recurring",
    name: "Daily plan",
    prompt: "Daily plan",
    trigger: { kind: "cron", expr: "30 9 * * *", tz: "Europe/Berlin" },
  });
  f.advance(30 * 86400000);
  await f.restart();
  const [deferred] = await f.native.list({ includeDisabled: true });
  assert.equal(deferred.state.nextRunAtMs, f.now + 120000);
  assert.equal(deferred.state.startupCatchupAtMs, f.now + 120000);
  assert.equal(f.executions.length, 0);
  f.advance(60000);
  await f.restart();
  const [stillDeferred] = await f.native.list({ includeDisabled: true });
  assert.equal(stillDeferred.state.nextRunAtMs, deferred.state.nextRunAtMs);
  assert.equal(f.executions.length, 0, "another restart must preserve the deferral");
  f.advance(60000);
  await f.tick();
  assert.equal(f.executions.length, 1);
  const [completed] = await f.native.list({ includeDisabled: true });
  assert.equal(completed.state.lastRunStatus, "ok");
  assert.equal(iso(completed.state.nextRunAtMs), "2027-04-01T07:30:00.000Z");
  await f.deliver();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  await f.restart();
  await f.deliver();
  assert.equal(f.executions.length, 1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  assert.equal(f.reminders.bindings.get(routine.id).state, "bound");
  await f.tick();
  assert.equal(f.executions.length, 1, "restart must preserve the future slot");
  f.advance(completed.state.nextRunAtMs - f.now);
  await f.tick();
  await f.deliver();
  assert.equal(f.executions.length, 2, "normal scheduling resumes after catch-up");
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.service.outbox.all(f.channel.id).length, 2);
});

test("overdue one-shot survives downtime once, including skipMissedJobs", async (t) => {
  const f = await fixture(t, { skipMissedJobs: true });
  // Keep AgentPier's admission check deterministic as calendar years advance.
  t.mock.timers.enable({ apis: ["Date"], now: f.now });
  const reminder = await f.reminders.create(f.id, {
    clientRequestId: "downtime-one-shot",
    name: "Reminder",
    message: "Remember this",
    schedule: { kind: "at", at: iso(f.now + 60000) },
  });
  f.advance(30 * 86400000);
  await f.restart();
  assert.equal(f.executions.length, 0);
  const [deferred] = await f.native.list({ includeDisabled: true });
  assert.equal(deferred.state.startupCatchupAtMs, f.now + 120000);
  f.advance(120000);
  await f.tick();
  await f.deliver();
  assert.equal(f.executions.length, 1);
  assert.equal(f.deliveries.length, 1);
  await f.restart();
  await f.deliver();
  const jobs = await f.native.list({ includeDisabled: true });
  const nativeId = f.reminders.bindings.get(reminder.id).nativeId;
  assert.ok(!jobs.some((job) => job.id === nativeId && job.enabled));
  assert.equal(f.executions.length, 1);
  assert.equal(f.deliveries.length, 1);
});

test("native skipMissedJobs advances recurring schedules without replay", async (t) => {
  const f = await fixture(t, { skipMissedJobs: true });
  await f.routines.create(f.id, {
    clientRequestId: "skip-recurring",
    name: "Daily plan",
    prompt: "Daily plan",
    trigger: { kind: "cron", expr: "30 9 * * *", tz: "Europe/Berlin" },
  });
  f.advance(30 * 86400000);
  await f.restart();
  const [job] = await f.native.list({ includeDisabled: true });
  assert.equal(iso(job.state.nextRunAtMs), "2027-04-01T07:30:00.000Z");
  assert.equal(job.state.startupCatchupAtMs, undefined);
  await f.tick();
  await f.deliver();
  assert.equal(f.executions.length, 0);
  assert.equal(f.deliveries.length, 0);
});

test("paused and event routines remain disabled across prolonged downtime", async (t) => {
  const f = await fixture(t);
  const paused = await f.routines.create(f.id, {
    clientRequestId: "paused",
    name: "Paused",
    prompt: "Paused plan",
    trigger: { kind: "cron", expr: "30 9 * * *", tz: "Europe/Berlin" },
  });
  await f.routines.update(f.id, paused.id, { enabled: false, revision: paused.revision });
  await f.routines.create(f.id, {
    clientRequestId: "event",
    name: "Event",
    prompt: "Event plan",
    trigger: { kind: "event" },
  });
  f.advance(30 * 86400000);
  await f.restart();
  const jobs = await f.native.list({ includeDisabled: true });
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => !job.enabled && !job.state.nextRunAtMs));
  assert.equal(f.executions.length, 0);
  assert.equal(f.deliveries.length, 0);
});

test("restart defers several overdue agent jobs in five-second steps", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++)
    await f.routines.create(f.id, {
      clientRequestId: `backlog-${i}`,
      name: `Plan ${i}`,
      prompt: `Plan ${i}`,
      trigger: { kind: "cron", expr: "30 9 * * *", tz: "Europe/Berlin" },
    });
  f.advance(30 * 86400000);
  await f.restart();
  const jobs = await f.native.list({ includeDisabled: true });
  assert.deepEqual(
    jobs.map((job) => job.state.startupCatchupAtMs - f.now).sort((a, b) => a - b),
    [120000, 125000, 130000],
  );
  f.advance(120000);
  for (let i = 1; i <= 3; i++) {
    await f.tick();
    assert.equal(f.executions.length, i);
    f.advance(5000);
  }
  await f.deliver();
  assert.equal(f.deliveries.length, 3);
  await f.restart();
  await f.deliver();
  assert.equal(f.executions.length, 3);
  assert.equal(f.deliveries.length, 3);
});

test("a running scheduler coalesces thirty days of sleep without startup deferral", async (t) => {
  const f = await fixture(t);
  await f.routines.create(f.id, {
    clientRequestId: "sleep",
    name: "Daily plan",
    prompt: "Daily plan",
    trigger: { kind: "cron", expr: "30 9 * * *", tz: "Europe/Berlin" },
  });
  await f.native.start();
  f.advance(30 * 86400000);
  await f.tick();
  await f.deliver();
  assert.equal(f.executions.length, 1);
  assert.equal(f.deliveries.length, 1);
  const [job] = await f.native.list({ includeDisabled: true });
  assert.equal(iso(job.state.nextRunAtMs), "2027-04-01T07:30:00.000Z");
  await f.tick();
  await f.deliver();
  assert.equal(f.executions.length, 1);
  assert.equal(f.deliveries.length, 1);
});
