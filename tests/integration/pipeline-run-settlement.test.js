import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../helpers/pipeline-engine.js";

function verifier() {
  const jobs = new Map(),
    plans = [];
  return {
    jobs,
    plans,
    async start(input) {
      plans.push(input);
      jobs.set(input.id, { status: "running" });
      return { id: input.id };
    },
    async inspect(job) {
      return jobs.get(job.id);
    },
    async cancel(job) {
      jobs.set(job.id, { status: "unavailable" });
    },
  };
}
const start = (f) =>
  f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
function writeVerdict(f, verdict = { result: "pass", summary: "Done" }) {
  const launch = f.launches.at(-1),
    file = path.join(launch.cwd, launch.verdictPath);
  fs.writeFileSync(file, JSON.stringify(verdict));
  const at = Math.ceil(f.engine.nowMs() / 1000);
  fs.utimesSync(file, at, at);
}
// A CLI that reported its terminal event and wrote its verdict, but never exits.
function lingering(f, now, nativeResult = "completed") {
  f.outcomes.set(f.launches.at(-1).sessionId, {
    status: "running",
    nativeResult,
    lastActivityAt: new Date(now).toISOString(),
  });
}
function stoppedAfter(f, nativeResult = "completed") {
  const stopped = [];
  f.driver.cancel = async (input) => {
    stopped.push(input.sessionId);
    f.outcomes.set(input.sessionId, {
      status: "failed",
      exitCode: 128,
      isError: true,
      quiesced: true,
      nativeResult,
    });
  };
  return stopped;
}

test("a completed native turn whose CLI never exits is stopped after the grace period and concludes", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { completionGraceMs: 30000 },
  });
  const stopped = stoppedAfter(f);
  const r = await start(f);
  writeVerdict(f);
  lingering(f, now);
  await f.engine.reconcile();
  assert.equal(stopped.length, 0);
  assert.equal(f.engine.get(r.id).status, "running");
  now += 30001;
  await f.engine.reconcile();
  assert.deepEqual(stopped, [f.launches[0].sessionId]);
  const settling = f.engine.get(r.id);
  assert.ok(settling.executionLog[0].settledAfterCompletion);
  await f.engine.reconcile();
  const run = f.engine.get(r.id);
  assert.equal(run.status, "completed");
  assert.equal(run.nodes[0].status, "passed");
  assert.equal(run.executionLog[0].verdict.result, "pass");
});

test("a settled turn is only accepted when the native output still reports completion", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { completionGraceMs: 1000 },
  });
  stoppedAfter(f, "failed");
  const r = await start(f);
  writeVerdict(f);
  lingering(f, now);
  now += 1001;
  await f.engine.reconcile();
  await f.engine.reconcile();
  const run = f.engine.get(r.id);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes[0].failReason, "session-error");
});

test("a native turn without a completion event is never stopped early", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { completionGraceMs: 1000 },
  });
  const stopped = stoppedAfter(f);
  const r = await start(f);
  lingering(f, now, null);
  now += 60000;
  await f.engine.reconcile();
  assert.equal(stopped.length, 0);
  assert.equal(f.engine.get(r.id).status, "running");
});

test("a turn exceeding the configured wall-clock timeout fails clearly instead of working forever", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { turnTimeoutMs: 600000, completionGraceMs: 30000 },
  });
  const stopped = stoppedAfter(f, null);
  const r = await start(f);
  for (let i = 0; i < 11; i++) {
    lingering(f, now, null);
    await f.engine.reconcile();
    now += 60000;
  }
  const run = f.engine.get(r.id);
  assert.equal(stopped.length, 1);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes[0].status, "failed");
  assert.equal(run.nodes[0].failReason, "turn-timeout");
  assert.ok(run.actions.includes("retry"));
  assert.ok(!run.actions.includes("reconcile"));
});

test("the inactivity timeout is configurable", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { inactivityTimeoutMs: 120000 },
  });
  stoppedAfter(f, null);
  const r = await start(f);
  lingering(f, now, null);
  now += 120001;
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "inactivity-timeout");
});

test("override of a failed stage still requires its configured human approval", async (t) => {
  const audits = [];
  const f = fixture(t, {
    gate: true,
    options: { audit: { append: (e) => audits.push(e) } },
  });
  const r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "session-error");
  await f.engine.gate(r.id, { action: "override" });
  const gated = f.engine.get(r.id);
  assert.notEqual(gated.status, "completed");
  assert.equal(gated.status, "awaiting-human");
  assert.equal(gated.nodes[0].status, "awaiting-gate");
  assert.equal(gated.nodes[0].failReason, undefined);
  assert.equal(gated.nodes[0].overridden, true);
  assert.equal(gated.nodes[0].overrides.length, 1);
  assert.equal(gated.nodes[0].overrides[0].failReason, "session-error");
  assert.deepEqual(gated.actions.includes("accept"), true);
  assert.equal(gated.actions.includes("override"), false);
  assert.deepEqual(
    audits.map((e) => [e.action, e.resourceId]),
    [["pipeline.overridden", r.id]],
  );
  await f.engine.gate(r.id, { action: "accept" });
  assert.equal(f.engine.get(r.id).status, "completed");
});

test("override of a failed stage still runs its configured verification", async (t) => {
  const verify = verifier(),
    f = fixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "true", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(verify.plans.length, 1);
  assert.equal(f.engine.get(r.id).status, "running");
  verify.jobs.set(verify.plans[0].id, {
    status: "pass",
    steps: [{ name: "check", exitCode: 0 }],
  });
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).status, "completed");
});

for (const gated of [false, true])
  test(`cancel closes the active stage status consistently (${gated ? "gate" : "running"})`, async (t) => {
    const f = fixture(t, { gate: true, loop: true });
    const r = await start(f);
    if (gated) await f.end(undefined, { nativeId: "native" });
    assert.equal(f.engine.get(r.id).nodes[0].status, gated ? "awaiting-gate" : "running");
    await f.engine.cancel(r.id);
    const run = f.engine.get(r.id);
    assert.equal(run.status, "cancelled");
    assert.equal(run.nodes[0].status, "cancelled");
    assert.ok(run.nodes[0].finishedAt);
    assert.equal(run.nodes[1].status, "pending");
    assert.ok(
      run.nodes.every((node) => !["running", "awaiting-gate"].includes(node.status)),
    );
  });

test("a failed verification repair without a fresh verdict parks on the verification failure", async (t) => {
  const verify = verifier(),
    f = fixture(t, { verification: true, verify });
  f.definitions.getVerification = () => ({
    steps: [{ name: "tests", command: "false", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  await f.end(undefined, { nativeId: "native" });
  verify.jobs.set(verify.plans[0].id, {
    status: "fail",
    steps: [{ name: "tests", exitCode: 3, blocking: true }],
  });
  await f.engine.reconcile();
  for (let i = 0; i < 3; i++) {
    f.outcomes.set(f.launches.at(-1).sessionId, {
      status: "completed",
      exitCode: 0,
      nativeId: "native",
      quiesced: true,
    });
    await f.engine.reconcile();
  }
  const node = f.engine.get(r.id).nodes[0];
  assert.equal(node.failReason, "verify-failed");
  assert.match(node.failDetail, /tests/);
  assert.match(node.failDetail, /3/);
});

test("check result again is only offered while the turn outcome can still succeed", async (t) => {
  const f = fixture(t);
  const r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  const run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "session-error");
  assert.ok(!run.actions.includes("reconcile"));
  assert.ok(run.actions.includes("override"));
});
