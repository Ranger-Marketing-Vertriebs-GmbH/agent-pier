import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fixture } from "../helpers/pipeline-engine.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { availableActions } from "../../server/features/pipelines/pipeline-actions.js";

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
const audited = () => {
  const events = [];
  return { events, audit: { append: (event) => events.push(event) } };
};
function missingVerdict(f) {
  f.outcomes.set(f.launches.at(-1).sessionId, {
    status: "completed",
    exitCode: 0,
    nativeId: "native",
    quiesced: true,
  });
  return f.engine.reconcile();
}

test("override at a parked gate is the gate decision and is audited with its path", async (t) => {
  const { events, audit } = audited();
  const f = fixture(t, { gate: true, options: { audit } });
  const r = await start(f);
  for (let i = 0; i < 3; i++) await missingVerdict(f);
  const parked = f.engine.get(r.id);
  assert.equal(parked.nodes[0].status, "awaiting-gate");
  assert.equal(parked.nodes[0].failReason, "verdict-missing");
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.deepEqual(events.at(-1).details, {
    kind: "gate",
    stageId: "build",
    failReason: "verdict-missing",
    path: "gate-decision",
  });
});

test("override of failed verification advances without verification or gate", async (t) => {
  const { events, audit } = audited();
  const verify = verifier(),
    f = fixture(t, { gate: true, verification: true, verify, options: { audit } });
  f.definitions.getVerification = () => ({
    steps: [{ name: "check", command: "false", timeoutMs: 1000, blocking: true }],
  });
  const r = await start(f);
  for (let i = 0; i < 3; i++) {
    await f.end(undefined, { nativeId: "native" });
    verify.jobs.set(verify.plans.at(-1).id, {
      status: "fail",
      steps: [{ name: "check", exitCode: 1 }],
    });
    await f.engine.reconcile();
  }
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "verify-failed");
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(verify.plans.length, 3);
  assert.equal(events.at(-1).details.path, "skips-checks");
});

test("override of a failed turn is audited as continuing into its checks", async (t) => {
  const { events, audit } = audited();
  const f = fixture(t, { gate: true, options: { audit } });
  const r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).nodes[0].status, "awaiting-gate");
  assert.deepEqual(events.at(-1).details, {
    kind: "gate",
    stageId: "build",
    failReason: "session-error",
    path: "checks-follow",
  });
});

test("a timed-out turn stopped through the launcher can be overridden", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { turnTimeoutMs: 60000 },
  });
  const finished = [];
  f.driver.finish = async (input) => {
    finished.push(input.sessionId);
    f.outcomes.set(input.sessionId, {
      status: "failed",
      exitCode: 128,
      isError: true,
      quiesced: true,
    });
  };
  const r = await start(f);
  f.outcomes.set(f.launches[0].sessionId, {
    status: "running",
    lastActivityAt: new Date(now).toISOString(),
  });
  now += 60001;
  await f.engine.reconcile();
  assert.deepEqual(finished, [f.launches[0].sessionId]);
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "turn-timeout");
  assert.ok(f.engine.get(r.id).actions.includes("override"));
  await f.engine.gate(r.id, { action: "override" });
  assert.equal(f.engine.get(r.id).status, "completed");
});

test("a settle stop that did not land is repeated after another grace period", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { completionGraceMs: 1000 },
  });
  const finished = [];
  f.driver.finish = async (input) => finished.push(input.sessionId);
  await start(f);
  f.outcomes.set(f.launches[0].sessionId, {
    status: "running",
    nativeResult: "completed",
    lastActivityAt: new Date(now).toISOString(),
  });
  now += 1001;
  await f.engine.reconcile();
  await f.engine.reconcile();
  assert.equal(finished.length, 1);
  // A shorter grace still leaves the launcher time to exit before the next signal.
  now += 1001;
  await f.engine.reconcile();
  assert.equal(finished.length, 1);
  now += 1000;
  await f.engine.reconcile();
  assert.equal(finished.length, 2);
});

test("a restart after the settle flag was saved concludes once the CLI has stopped", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { completionGraceMs: 1000 },
  });
  f.driver.finish = async () => {
    throw Error("simulated crash before the stop landed");
  };
  const r = await start(f);
  const launch = f.launches[0];
  fs.writeFileSync(
    path.join(launch.cwd, launch.verdictPath),
    JSON.stringify({ result: "pass", summary: "Done" }),
  );
  const at = Math.ceil(now / 1000);
  fs.utimesSync(path.join(launch.cwd, launch.verdictPath), at, at);
  f.outcomes.set(launch.sessionId, {
    status: "running",
    nativeResult: "completed",
    lastActivityAt: new Date(now).toISOString(),
  });
  now += 1001;
  await f.engine.reconcile();
  assert.ok(f.engine.store.get(r.id).executionLog[0].settledAfterCompletion);
  await f.restart();
  f.engine.driver.finish = async (input) =>
    f.outcomes.set(input.sessionId, {
      status: "failed",
      exitCode: 128,
      isError: true,
      quiesced: true,
      nativeResult: "completed",
    });
  now += 2000; // The repeated stop waits at least two seconds.
  await f.engine.reconcile();
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).status, "completed");
});

test("a turn not owned by the current attempt is never stopped on its behalf", async (t) => {
  let now = Date.parse("2026-10-10T10:00:00.000Z");
  const f = fixture(t, {
    clock: { now: () => now },
    options: { completionGraceMs: 1000 },
  });
  const finished = [];
  f.driver.finish = async (input) => finished.push(input.sessionId);
  const r = await start(f);
  const run = f.engine.store.get(r.id);
  run.executionLog[0].sessionId = "another-session";
  f.engine.store.save(run);
  f.outcomes.set(f.launches[0].sessionId, {
    status: "running",
    nativeResult: "completed",
    lastActivityAt: new Date(now).toISOString(),
  });
  now += 7200000 * 4;
  await f.engine.reconcile();
  assert.deepEqual(finished, []);
});

test("a pipeline with a pull request edge cannot start in a repository without a remote", async (t) => {
  const f = fixture(t);
  const { graph } = f.definitions.snapshot().pipeline;
  graph.nodes.push({ id: "pr", kind: "createPr" });
  graph.edges.push({ from: "build", to: "pr", condition: "default" });
  f.workspace.hasRemote = async () => false;
  await assert.rejects(start(f), {
    status: 409,
    message: serverMessages.pipelineWorkspaces.noRemoteForPullRequest,
  });
  assert.equal(f.engine.list().total, 0);
  assert.equal(f.launches.length, 0);
});

test("cancelled runs offer no pull request", () => {
  const workspace = { hasRemote: true };
  assert.deepEqual(availableActions({ status: "cancelled", workspace }), ["delete"]);
  assert.deepEqual(availableActions({ status: "completed", workspace }), [
    "delete",
    "create-pr",
  ]);
});

test("a failed native turn shows the native error in its detail", async (t) => {
  const f = fixture(t);
  const r = await start(f);
  await f.end(undefined, {
    status: "failed",
    exitCode: 1,
    isError: true,
    error: "llama.cpp: Failed to parse tool call arguments",
  });
  assert.equal(
    f.engine.get(r.id).nodes[0].failDetail,
    serverMessages.pipelines.nativeTurnFailedWith(
      "llama.cpp: Failed to parse tool call arguments",
    ),
  );
});

test("runs stored with the former stage-timeout reason keep their recovery actions", async (t) => {
  const f = fixture(t);
  const r = await start(f);
  await f.end(undefined, { status: "failed", exitCode: 1, quiesced: true });
  const stored = f.engine.store.get(r.id);
  stored.nodes[0].failReason = "stage-timeout";
  stored.executionLog[0].failReason = "stage-timeout";
  delete stored.executionLog[0].exitCode;
  f.engine.store.save(stored);
  await f.restart();
  const run = f.engine.get(r.id);
  assert.equal(run.nodes[0].failReason, "turn-timeout");
  for (const action of ["retry", "override", "reconcile"])
    assert.ok(run.actions.includes(action), action);
  await f.engine.retry(r.id);
  assert.equal(f.launches.length, 2);
});

test("a cwd outside a repository leaves the start to the usual preparation error", async () => {
  const { PipelineWorkspace } =
    await import("../../server/features/pipelines/workspace-manager.js");
  const manager = new PipelineWorkspace({
    dataDir: fs.mkdtempSync(path.join(f0(), "d")),
  });
  assert.equal(await manager.hasRemote(path.join(f0(), "missing")), true);
});
function f0() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentpier-noremote-"));
}
