import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import {
  hermesCreate,
  hermesCronRunOf,
  hermesSchedule,
  hermesUpdates,
  routineMeta,
  routineOfJob,
  runSessionKey,
} from "../../server/features/assistants/runtimes/hermes/hermes-routine-jobs.js";
import { storedIdOf } from "../../server/features/assistants/runtimes/hermes/hermes-run-state.js";
import {
  routineRunOf,
  runtimeForSession,
} from "../../server/features/assistants/runtimes/runtime-for.js";
import { makeHermesRuntime } from "../helpers/hermes-fake-gateway.js";

const routine = (extra = {}) => ({
  name: "Inbox",
  marker: "agentpier-reminder:b1",
  agentId: "ap-1",
  enabled: true,
  keepAfterRun: true,
  schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Europe/Berlin" },
  wakeNow: true,
  alertOnFailure: false,
  target: { kind: "chat", sessionKey: "agent:ap-1:hermes:local-1" },
  prompt: {
    text: "Check the inbox\n",
    timeoutSeconds: 300,
    fullContext: true,
    tools: [],
  },
  delivery: { kind: "chat", url: "http://127.0.0.1:9/complete/b1" },
  ...extra,
});

test("a routine becomes a paused Hermes job with AgentPier's part beside it", () => {
  const berlin = { zone: "Europe/Berlin" };
  assert.deepEqual(
    hermesCreate(routine({ prompt: { text: "Hi", model: "p/m-1" } }), berlin),
    {
      name: "Inbox",
      schedule: "0 9 * * *",
      prompt: "Hi",
      model: "m-1",
      deliver: "local",
      paused: true,
    },
  );
  assert.equal(hermesSchedule({ kind: "every", everyMs: 1800000 }), "every 30m");
  assert.equal(
    hermesSchedule({ kind: "at", at: "2026-11-02T09:00:00+01:00" }),
    "2026-11-02T08:00:00.000Z",
  );
  for (const schedule of [
    { kind: "every", everyMs: 90000 },
    { kind: "cron", expression: "0 9 * *" },
    { kind: "at", at: "soon" },
  ])
    assert.throws(
      () => hermesSchedule(schedule),
      (e) => e.code === "INVALID_REQUEST",
    );
  assert.throws(
    () => hermesCreate(routine({ prompt: { text: "" } })),
    (e) => e.code === "INVALID_REQUEST",
  );
});

test("a Hermes job reads back as the routine AgentPier submitted", () => {
  const submitted = routine();
  const meta = routineMeta(submitted);
  assert.equal(meta.revision, 1);
  // Hermes stores the trimmed prompt, its parsed schedule and the run state.
  const job = {
    id: "abc123",
    name: "Inbox",
    prompt: "Check the inbox",
    model: null,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    enabled: true,
    next_run_at: "2026-11-02T09:00:00+01:00",
    last_run_at: "2026-11-01T09:00:03+01:00",
    last_status: "delivery_failed",
    last_error: null,
    failure_streak: 0,
    fire_claim: { at: "2026-11-01T09:10:00+01:00", by: "x" },
    agentpier: meta,
  };
  const read = routineOfJob(job, { agentId: "ap-1", delivered: "delivered" });
  for (const field of [
    "name",
    "marker",
    "agentId",
    "schedule",
    "target",
    "prompt",
    "delivery",
  ])
    assert.deepEqual(read[field], submitted[field], field);
  assert.equal(read.revision, 1);
  assert.deepEqual(read.runState, {
    nextRunAtMs: Date.parse("2026-11-02T09:00:00+01:00"),
    runningAtMs: Date.parse("2026-11-01T09:10:00+01:00"),
    lastRunAtMs: Date.parse("2026-11-01T09:00:03+01:00"),
    // Hermes's own delivery failed, the agent did not: the run is ok.
    lastStatus: "ok",
    lastDeliveryStatus: "delivered",
    failuresInRow: 0,
  });
  // An update's meta keeps what the patch leaves out and counts the revision.
  const next = routineMeta({ enabled: false }, meta);
  assert.equal(next.revision, 2);
  assert.equal(next.marker, meta.marker);
  assert.deepEqual(hermesUpdates({ name: "New" }, next), {
    name: "New",
    agentpier: next,
  });
  // A job of the agent's own: no marker, its own session, nothing delivered here.
  const own = routineOfJob(
    { id: "own1", name: "Mine", prompt: "x", schedule: { kind: "interval", minutes: 5 } },
    { agentId: "ap-1" },
  );
  assert.equal(own.marker, null);
  assert.deepEqual(own.target, { kind: "own" });
  assert.deepEqual(own.delivery, { kind: "none" });
  assert.deepEqual(own.schedule, { kind: "every", everyMs: 300000 });
  assert.equal(routineOfJob({ name: "no id" }), null);
});

test("a routine run's session key names its agent, job and run", () => {
  const key = runSessionKey("ap-1", "abc123", "local-77");
  assert.equal(key, "agent:ap-1:hermes:cron:abc123:local-77");
  const run = {
    agentId: "ap-1",
    routineId: "abc123",
    runId: "local-77",
    routineSession: "agent:ap-1:hermes:cron:abc123",
  };
  assert.deepEqual(hermesCronRunOf(key), run);
  assert.deepEqual(hermesCronRunOf(run.routineSession), { ...run, runId: null });
  // The sessions sub-port reads the run's own stored session; the job's key names none.
  assert.equal(storedIdOf("ap-1", key), "local-77");
  assert.equal(storedIdOf("ap-1", run.routineSession), null);
  assert.equal(storedIdOf("ap-1", "agent:ap-1:hermes:local-5"), "local-5");
  // Callers that know only the key reach Hermes's reader, OpenClaw's keys stay its own.
  assert.deepEqual(routineRunOf(null, key), run);
  assert.deepEqual(routineRunOf({ runtime: "hermes" }, key), run);
  assert.equal(routineRunOf(null, "agent:ap-1:hermes:local-5"), null);
  assert.equal(routineRunOf(null, "agent:ap-1:cron:job-1").routineId, "job-1");
  for (const key of [undefined, null, 1, "", "agent:ap-1:main"])
    assert.equal(hermesCronRunOf(key), null, String(key));
  const supervisor = {};
  assert.equal(
    runtimeForSession(key, supervisor),
    runtimeForSession("agent:ap-1:hermes:local-5", supervisor),
  );
});

test("a run's result reaches AgentPier's webhook once, and a disabled routine stays paused", async () => {
  const posted = [];
  const post = async (url, request) => {
    posted.push({
      url,
      auth: request.headers.authorization,
      ...JSON.parse(request.body),
    });
    return { ok: true, status: 204 };
  };
  const runtime = await makeHermesRuntime("ap-1")({ post });
  const { routines } = runtime;
  const added = await routines.add({ routine: routine({ enabled: false }) });
  assert.equal(added.enabled, false);
  assert.deepEqual(await routines.run({ id: added.id }), {
    queued: false,
    refused: true,
  });
  assert.deepEqual(await routines.run({ id: added.id, force: true }), {
    queued: true,
    refused: false,
  });
  // Hermes's forced run resumed the job; AgentPier paused it again.
  const [listed] = await routines.list({ agentId: "ap-1" });
  assert.equal(listed.enabled, false);
  for (let i = 0; i < 200 && !posted.length; i++) await tick();
  assert.equal(posted.length, 1);
  const [event] = posted;
  assert.equal(event.url, "http://127.0.0.1:9/complete/b1");
  assert.equal(event.auth, `Bearer ${"t".repeat(64)}`);
  assert.equal(event.jobId, added.id);
  assert.equal(event.status, "ok");
  assert.equal(event.summary, "ECHO: Check the inbox");
  assert.ok(Number.isSafeInteger(event.runAtMs));
  assert.deepEqual(routines.runOf(event.sessionKey).routineId, added.id);
  // The run's session is a stored session the sessions sub-port reads.
  const history = await runtime.sessions.history({ sessionKey: event.sessionKey });
  assert.deepEqual(
    history.messages.map((m) => m.entry.text),
    ["Check the inbox", "ECHO: Check the inbox"],
  );
  const { entries } = await routines.runs({ id: added.id, limit: 5 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionKey, event.sessionKey);
  // Further runs' checks deliver nothing twice; the status shows the delivery.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [after] = await routines.list();
  assert.equal(after.runState.lastDeliveryStatus, "delivered");
  assert.equal(posted.length, 1);
});
