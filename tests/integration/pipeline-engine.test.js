import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "../helpers/pipeline-engine.js";

test("pipeline completion requires real successful turn and fresh verdict; immutable snapshots survive restart", async (t) => {
  const f = fixture(t);
  const run = await f.engine.start({
    pipelineId: "definition",
    cwd: f.dir,
    task: "Task",
  });
  assert.equal(run.status, "running");
  assert.equal(f.launches.length, 1);
  await f.restart();
  assert.equal(f.launches.length, 1);
  await f.end();
  const final = f.engine.get(run.id);
  assert.equal(final.status, "completed");
  assert.equal(final.nodes[0].status, "passed");
  assert.equal(final.executionLog.length, 1);
  await f.engine.reconcile();
  assert.equal(f.engine.get(run.id).executionLog.length, 1);
});

test("human gate feedback preserves native conversation and cancellation preserves dirty workspace", async (t) => {
  const f = fixture(t, { gate: true });
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  await f.end(undefined, { nativeId: "native-fixture" });
  assert.equal(f.engine.get(r.id).status, "awaiting-human");
  await f.engine.gate(r.id, { action: "feedback", feedback: "Correct it" });
  assert.equal(f.launches.at(-1).resumeNativeId, "native-fixture");
  fs.writeFileSync(path.join(r.workingDir, "uncommitted.txt"), "preserve");
  await f.engine.cancel(r.id);
  assert.equal(f.engine.get(r.id).status, "cancelled");
  assert.equal(
    fs.readFileSync(path.join(r.workingDir, "uncommitted.txt"), "utf8"),
    "preserve",
  );
});

test("fail loop budget gates exhausted review and does not use default edge on failure", async (t) => {
  const f = fixture(t, { loop: true });
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  await f.end();
  await f.end({
    result: "fail",
    summary: "Repair",
    findings: [{ severity: "high", title: "Bug" }],
  });
  assert.equal(f.engine.get(r.id).currentNodeId, "build");
  await f.end();
  await f.end({ result: "fail", summary: "Still wrong" });
  const run = f.engine.get(r.id);
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.nodes.find((n) => n.id === "review").failReason, "verdict-fail");
  assert.equal(f.launches.length, 4);
});

test("error outcome cannot conclude on valid verdict and missing verdict has bounded continuations", async (t) => {
  const f = fixture(t);
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  await f.end(
    { result: "pass", summary: "Stale pass" },
    { exitCode: 1, status: "failed" },
  );
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "session-error");
  await f.engine.retry(r.id);
  for (let i = 0; i < 3; i++) {
    const l = f.launches.at(-1);
    f.outcomes.set(l.sessionId, { status: "completed", exitCode: 0 });
    await f.engine.reconcile();
  }
  assert.equal(f.engine.get(r.id).nodes[0].failReason, "verdict-missing");
  assert.equal(f.launches.length, 4);
});

test("run filtering, phase checks and profile usage count use persisted attempts", async (t) => {
  const f = fixture(t);
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  assert.equal(f.engine.hasActiveRuns("definition"), true);
  assert.deepEqual(f.engine.profileStats("profile"), { stageRunsLast7Days: 1 });
  assert.throws(() => f.engine.list({ status: "invented" }), { status: 400 });
  await assert.rejects(f.engine.gate(r.id, { action: "accept" }), { status: 409 });
  await f.end();
  assert.equal(f.engine.hasActiveRuns("definition"), false);
  assert.equal(f.engine.list({ status: "completed" }).total, 1);
});

test("recovery finishes a durably recorded verdict without launching duplicate work", async (t) => {
  const f = fixture(t);
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  const stored = f.engine.store.get(r.id);
  stored.activeTurn = null;
  stored.pendingConclusion = {
    nodeId: "build",
    verdict: { result: "pass", summary: "Durable completed work" },
  };
  f.engine.store.save(stored);
  await f.restart();
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(f.launches.length, 1);
});

test("artifact reads require a declaration from that node and refuse symlink escapes", async (t) => {
  const f = fixture(t);
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  fs.writeFileSync(path.join(f.dir, "outside"), "private");
  fs.symlinkSync(path.join(f.dir, "outside"), path.join(r.workingDir, "escape"));
  await f.end({ result: "pass", summary: "done", artifacts: [{ path: "escape" }] });
  assert.throws(() => f.engine.artifact(r.id, "build", "escape"), { status: 403 });
  assert.throws(() => f.engine.artifact(r.id, "build", "other"), { status: 404 });
  assert.throws(() => f.engine.artifact(r.id, "unknown", "escape"), { status: 404 });
});

test("late prior-turn verdict cannot settle a newer continuation and each turn gets a private path", async (t) => {
  const f = fixture(t);
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  const first = f.launches.at(-1);
  f.outcomes.set(first.sessionId, {
    status: "completed",
    exitCode: 0,
    nativeId: "conversation",
  });
  await f.engine.reconcile();
  const second = f.launches.at(-1);
  assert.notEqual(first.verdictPath, second.verdictPath);
  fs.writeFileSync(
    path.join(first.cwd, first.verdictPath),
    JSON.stringify({ result: "pass", summary: "Late old work" }),
  );
  f.outcomes.set(second.sessionId, {
    status: "completed",
    exitCode: 0,
    nativeId: "conversation",
  });
  await f.engine.reconcile();
  assert.equal(f.engine.get(r.id).status, "running");
  assert.equal(f.launches.length, 3);
});

test("declared credential files are denied at every depth while ordinary reports remain readable", async (t) => {
  const f = fixture(t);
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  const privateFiles = [
    "nested/.git/config",
    "nested/.ssh/id_rsa",
    "nested/.aws/credentials",
    "nested/.azure/accessTokens.json",
  ];
  for (const file of [...privateFiles, "nested/report.txt"]) {
    fs.mkdirSync(path.dirname(path.join(r.workingDir, file)), { recursive: true });
    fs.writeFileSync(path.join(r.workingDir, file), "fixture content");
  }
  await f.end({
    result: "pass",
    summary: "report",
    artifacts: [...privateFiles, "nested/report.txt"],
  });
  for (const file of privateFiles)
    assert.throws(() => f.engine.artifact(r.id, "build", file), { status: 403 });
  assert.equal(
    f.engine.artifact(r.id, "build", "nested/report.txt").text,
    "fixture content",
  );
});

test("polling queued behind a completing gate cannot reopen a terminal run", async (t) => {
  for (const action of ["accept", "abort"]) {
    const f = fixture(t, { gate: true });
    const r = await f.engine.start({
      pipelineId: "definition",
      cwd: f.dir,
      task: "Task",
    });
    await f.end();
    const gate = f.engine.gate(r.id, { action });
    const poll = f.engine.reconcile();
    await gate;
    const completed = f.engine.get(r.id);
    assert.equal(completed.status, action === "accept" ? "completed" : "cancelled");
    await poll;
    assert.deepEqual(f.engine.get(r.id), completed);
  }
});
