import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import {
  nextCronRun,
  parseCron,
  pinnedExpression,
} from "../../server/features/assistants/runtimes/hermes/hermes-cron-zone.js";
import {
  hermesSchedule,
  repinOf,
  routineMeta,
  routineOfJob,
} from "../../server/features/assistants/runtimes/hermes/hermes-routine-jobs.js";
import {
  fakeHermesSupervisor,
  hermesTestRuntime,
} from "../helpers/hermes-fake-gateway.js";

const at = (iso) => Date.parse(iso);
const next = (expression, zone, after) => {
  const ms = nextCronRun(expression, zone, at(after));
  return ms === null ? null : new Date(ms).toISOString();
};

test("a cron expression runs in its own time zone with OpenClaw's DST policy", () => {
  assert.equal(
    next("0 9 * * *", "Asia/Tokyo", "2026-11-01T12:00:00Z"),
    "2026-11-02T00:00:00.000Z",
  );
  // New York leaves summer time on 2026-11-01: 09:00 is 14:00 UTC from then on.
  assert.equal(
    next("0 9 * * MON-FRI", "America/New_York", "2026-10-31T12:00:00Z"),
    "2026-11-02T14:00:00.000Z",
  );
  // A wall-clock time the spring transition skips does not run that day.
  assert.equal(
    next("30 2 * * *", "Europe/Berlin", "2027-03-27T12:00:00Z"),
    "2027-03-29T00:30:00.000Z",
  );
  // A repeated autumn time runs at its first occurrence only.
  assert.equal(
    next("30 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z"),
    "2026-10-25T00:30:00.000Z",
  );
  assert.equal(
    next("30 2 * * *", "Europe/Berlin", "2026-10-25T01:00:00Z"),
    "2026-10-26T01:30:00.000Z",
  );
  // Half-hour offsets, steps, lists and the day fields' either-or.
  assert.equal(
    next("*/15 * * * *", "Asia/Kolkata", "2026-11-01T12:07:00Z"),
    "2026-11-01T12:15:00.000Z",
  );
  assert.equal(
    next("0 8 1 * SUN", "UTC", "2026-11-02T00:00:00Z"),
    "2026-11-08T08:00:00.000Z",
  );
  assert.equal(next("0 0 30 2 *", "UTC", "2026-11-01T00:00:00Z"), null);
  for (const expression of ["0 9 * *", "0 9 L * *", "61 * * * *", "0 9 * * 8"])
    assert.equal(parseCron(expression), null, expression);
  assert.equal(nextCronRun("0 9 * * *", "Mars/Olympus", 0), null);
  assert.equal(
    pinnedExpression(at("2026-11-02T00:00:00Z"), "Europe/Berlin"),
    "0 1 2 11 *",
  );
});

test("a routine in another time zone becomes a pinned Hermes job that reads back as given", () => {
  const schedule = { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" };
  const options = { zone: "Europe/Berlin", now: at("2026-11-01T12:00:00Z") };
  // Tokyo's next 09:00 is 01:00 in Berlin on 2 November.
  assert.equal(hermesSchedule(schedule, options), "0 1 2 11 *");
  // In the process's own zone, and without one, it runs as written.
  assert.equal(
    hermesSchedule({ ...schedule, timezone: "Europe/Berlin" }, options),
    "0 9 * * *",
  );
  assert.equal(
    hermesSchedule({ kind: "cron", expression: " 0 9 * * * " }, options),
    "0 9 * * *",
  );
  for (const bad of [
    { ...schedule, timezone: "Mars/Olympus" },
    { ...schedule, expression: "0 9 L * *" },
  ])
    assert.throws(
      () => hermesSchedule(bad, options),
      (e) => e.code === "INVALID_REQUEST",
    );
  const meta = routineMeta({ schedule });
  const job = {
    id: "z1",
    name: "Tokyo",
    prompt: "x",
    enabled: true,
    schedule: { kind: "cron", expr: "0 1 2 11 *" },
    next_run_at: "2026-11-02T01:00:00+01:00",
    agentpier: meta,
  };
  assert.deepEqual(routineOfJob(job).schedule, schedule);
  assert.equal(routineOfJob(job).runState.nextRunAtMs, at("2026-11-02T00:00:00Z"));
  // Pinned again once its occurrence passed, never while paused or running.
  assert.equal(repinOf(job, options), null);
  const ran = { ...options, now: at("2026-11-02T00:00:05Z") };
  assert.equal(repinOf(job, ran), "0 1 3 11 *");
  assert.equal(repinOf({ ...job, enabled: false }, ran), null);
  assert.equal(repinOf({ ...job, fire_claim: { at: "x" } }, ran), null);
  // Once Hermes runs in the routine's own zone (the owner's time zone for all
  // agents), the pin gives way to its own expression, which then needs none.
  const local = routineMeta({ schedule: { ...schedule, timezone: "Europe/Berlin" } });
  assert.equal(repinOf({ ...job, agentpier: local }, ran), schedule.expression);
  const own = { ...job, agentpier: local, schedule: { kind: "cron", expr: "0 9 * * *" } };
  assert.equal(repinOf(own, ran), null);
  assert.equal(repinOf(job, { ...ran, zone: "Asia/Tokyo" }), schedule.expression);
  // A job still on its own expression that is due when the zone changed is left to
  // Hermes, which fires the run it missed while restarting; then it is pinned.
  const unpinned = {
    ...job,
    agentpier: meta,
    schedule: { kind: "cron", expr: schedule.expression },
    next_run_at: "2026-11-02T00:00:00Z",
  };
  assert.equal(repinOf(unpinned, ran), null);
  const later = { ...unpinned, next_run_at: "2026-11-03T00:00:00Z" };
  assert.equal(repinOf(later, ran), "0 1 3 11 *");
});

const routine = (extra = {}) => ({
  name: "Tokyo",
  marker: "agentpier-reminder:z",
  agentId: "ap-1",
  enabled: true,
  keepAfterRun: true,
  schedule: { kind: "cron", expression: "30 6 * * *", timezone: "Asia/Tokyo" },
  wakeNow: true,
  alertOnFailure: false,
  target: { kind: "own" },
  prompt: { text: "Hi", timeoutSeconds: 60, fullContext: true, tools: [] },
  delivery: { kind: "none" },
  ...extra,
});

async function started(state = {}) {
  const supervisor = fakeHermesSupervisor({ agentId: "ap-1" });
  const runtime = hermesTestRuntime(supervisor, state);
  await supervisor.start();
  return { supervisor, runtime };
}

test("a routine in another time zone is pinned on Hermes and pinned again after its run", async () => {
  const { supervisor, runtime } = await started({ zone: "Europe/Berlin" });
  const { routines } = runtime;
  const added = await routines.add({ routine: routine() });
  assert.deepEqual(added.schedule, routine().schedule);
  const job = () => supervisor.store.cron.jobs.get(added.id);
  const pin = pinnedExpression(
    nextCronRun("30 6 * * *", "Asia/Tokyo", Date.now()),
    "Europe/Berlin",
  );
  assert.equal(job().schedule.expr, pin);
  // The pin of an occurrence that passed (the run happened) moves to the next one.
  job().schedule = { kind: "cron", expr: "0 0 1 1 *", display: "0 0 1 1 *" };
  await supervisor.deliveries.check();
  assert.equal(job().schedule.expr, pin);
  // Enabling a paused routine pins it to its next occurrence, too.
  await routines.update({ id: added.id, patch: { enabled: false } });
  job().schedule = { kind: "cron", expr: "0 0 1 1 *", display: "0 0 1 1 *" };
  const resumed = await routines.update({ id: added.id, patch: { enabled: true } });
  assert.equal(job().schedule.expr, pin);
  assert.deepEqual(resumed.schedule, routine().schedule);
});

test("a routine's result is written into its chat's history as a note the agent reads", async () => {
  const posted = [];
  const post = async (_url, request) => {
    posted.push(JSON.parse(request.body));
    return { ok: true, status: 204 };
  };
  const { supervisor, runtime } = await started({ post });
  const { key } = await runtime.sessions.create({ agentId: "ap-1", label: "Main" });
  const { routines } = runtime;
  const chat = await routines.add({
    routine: routine({
      schedule: { kind: "cron", expression: "0 9 * * *" },
      target: { kind: "chat", sessionKey: key },
      prompt: { text: "Summarize", timeoutSeconds: 60, fullContext: true, tools: [] },
      delivery: { kind: "chat", url: "http://127.0.0.1:9/complete/c" },
    }),
  });
  // A reminder that delivers elsewhere leaves the chat alone.
  const elsewhere = await routines.add({
    routine: routine({
      marker: "agentpier-reminder:w",
      schedule: { kind: "cron", expression: "0 9 * * *" },
      target: { kind: "chat", sessionKey: key },
      delivery: { kind: "webhook", url: "http://127.0.0.1:9/complete/w" },
    }),
  });
  await routines.run({ id: chat.id, force: true });
  await routines.run({ id: elsewhere.id, force: true });
  for (let i = 0; i < 400 && posted.length < 2; i++) await tick();
  assert.equal(posted.length, 2);
  assert.ok(posted.every((e) => e.deliveryStatus === "not-delivered"));
  const history = await runtime.sessions.history({ sessionKey: key });
  const rows = history.messages.filter((m) => m.display_kind === "internal_notification");
  assert.deepEqual(
    rows.map((m) => m.text),
    ["[Cron delivery: Tokyo]\nECHO: Summarize"],
  );
  // The chat view never shows it as the owner's words.
  assert.equal(rows[0].entry.internal, true);
  // A later check writes it once.
  await supervisor.deliveries.check();
  const again = await runtime.sessions.history({ sessionKey: key });
  assert.equal(again.messages.length, history.messages.length);
});

test("a Hermes chat names its last model call's context, across a gateway restart", async () => {
  const { supervisor, runtime } = await started();
  const { key } = await runtime.sessions.create({ agentId: "ap-1", label: "Main" });
  const before = await runtime.sessions.history({ sessionKey: key });
  assert.deepEqual(before.sessionInfo, { key, count: 0 });
  const [row] = supervisor.store.rows.values();
  row.stats = { last_prompt_tokens: 90000, context_length: 128000 };
  const { sessionInfo } = await runtime.sessions.history({ sessionKey: key });
  assert.deepEqual(sessionInfo, {
    key,
    count: 0,
    totalTokens: 90000,
    totalTokensFresh: true,
    contextTokens: 128000,
  });
  // After a restart the gateway keeps no agent for the session (and the session is
  // attached again only by its next turn): the size read last stands until then.
  await supervisor.restart();
  row.stats = { last_prompt_tokens: 0, context_length: 0 };
  const restarted = await runtime.sessions.history({ sessionKey: key });
  assert.equal(restarted.sessionInfo.totalTokens, 90000);
  assert.equal(restarted.sessionInfo.contextTokens, 128000);
  // A compression AgentPier asked for makes the size unknown again.
  await runtime.sessions.compact({ key }).catch(() => {});
  const compacted = await runtime.sessions.history({ sessionKey: key });
  assert.equal(compacted.sessionInfo.totalTokens, undefined);
});
