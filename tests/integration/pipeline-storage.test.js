import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { VerificationRunner } from "../../server/features/pipelines/verify-runner.js";
import { fixture } from "../helpers/pipeline-engine.js";
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-run-storage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("independent run stores reject stale writes without erasing a newer durable transition", (t) => {
  const dir = temporary(t),
    a = new RunStore(dir),
    b = new RunStore(dir);
  t.after(() => {
    a.close();
    b.close();
  });
  a.create({ id: "run", status: "running" });
  const stale = a.get("run"),
    fresh = b.get("run");
  fresh.status = "cancelled";
  b.save(fresh);
  stale.status = "completed";
  assert.throws(() => a.save(stale), { status: 409 });
  assert.equal(a.get("run").status, "cancelled");
});
test("run database and verification receipt symlinks never grant access outside private storage", async (t) => {
  const dir = temporary(t),
    outside = path.join(dir, "outside");
  fs.writeFileSync(outside, "private");
  fs.mkdirSync(path.join(dir, "pipeline-runs"));
  fs.symlinkSync(outside, path.join(dir, "pipeline-runs", "runs.sqlite"));
  assert.throws(() => new RunStore(dir), { status: 409 });
  assert.equal(fs.readFileSync(outside, "utf8"), "private");
  const runner = new VerificationRunner({ directory: dir });
  fs.mkdirSync(path.join(dir, "external"));
  fs.writeFileSync(
    path.join(dir, "external", "result.json"),
    '{"status":"pass","steps":[]}',
  );
  fs.symlinkSync(path.join(dir, "external"), path.join(dir, "verification", "forged"));
  await assert.rejects(
    runner.inspect({ id: "forged", startedAt: new Date().toISOString() }),
    { status: 409 },
  );
});
test("closing rejects new launches and waits for an existing run operation before closing storage", async (t) => {
  const f = fixture(t);
  let release;
  const original = f.driver.start;
  f.driver.start = async (input) => {
    await new Promise((r) => {
      release = r;
    });
    return original(input);
  };
  const first = f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  while (!release) await new Promise((r) => setImmediate(r));
  const close = f.engine.close();
  await assert.rejects(
    f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Late" }),
    { status: 503 },
  );
  release();
  await first;
  await close;
});

test("recovery adopts a prepared owned workspace before the missing first launch", async (t) => {
  const f = fixture(t);
  const prepared = path.join(f.dir, "already-prepared");
  fs.mkdirSync(prepared);
  f.workspace.prepare = async (input) => ({
    runId: input.runId,
    cwd: prepared,
    projectRoot: f.dir,
    projectId: "project",
    branch: "owned",
    baseSha: "head",
  });
  const { compileSnapshot } =
    await import("../../server/features/pipelines/graph-navigation.js");
  const graph = compileSnapshot(f.definitions.snapshot());
  f.engine.store.create({
    id: "interrupted-provision",
    pipelineId: "definition",
    pipelineName: "Test",
    task: "Task",
    cwd: f.dir,
    baseBranch: "main",
    status: "running",
    phase: "provisioning",
    ...graph,
    currentNodeId: graph.entry,
    workingDir: "",
    executionLog: [],
    loopState: {},
    createdAt: new Date().toISOString(),
  });
  await f.engine.recover();
  const run = f.engine.get("interrupted-provision");
  assert.equal(run.workingDir, prepared);
  assert.equal(run.status, "running");
  assert.equal(f.launches.length, 1);
  await f.engine.recover();
  assert.equal(f.launches.length, 1);
});

test("recovery after durable loop reset launches one repair without consuming another iteration", async (t) => {
  const f = fixture(t, { loop: true });
  const r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  await f.end();
  const save = f.engine.store.save.bind(f.engine.store);
  let interrupted = false;
  f.engine.store.save = (run) => {
    const result = save(run);
    if (!interrupted && run.loopState["review->build"]?.iterations === 1) {
      interrupted = true;
      throw Error("simulated process interruption after durable reset");
    }
    return result;
  };
  await f.end({
    result: "fail",
    summary: "Repair",
    findings: [{ severity: "high", title: "Issue" }],
  });
  assert.equal(f.launches.length, 2);
  await f.restart();
  assert.equal(f.launches.length, 3);
  assert.equal(f.engine.get(r.id).currentNodeId, "build");
  assert.equal(f.engine.get(r.id).loopState["review->build"].iterations, 1);
});

test("an interrupted operator reconciliation resumes its proven successful verdict", async (t) => {
  const f = fixture(t),
    r = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Task" });
  await f.end(undefined, { status: "failed", exitCode: 7 });
  f.outcomes.set(f.launches[0].sessionId, {
    status: "completed",
    exitCode: 0,
    quiesced: true,
  });
  const save = f.engine.store.save.bind(f.engine.store);
  let interrupted = false;
  f.engine.store.save = (run) => {
    const result = save(run);
    if (!interrupted && run.status === "running") {
      interrupted = true;
      throw Error("simulated process interruption");
    }
    return result;
  };
  await assert.rejects(f.engine.gate(r.id, { action: "reconcile" }), /simulated/);
  await f.restart();
  assert.equal(f.engine.get(r.id).status, "completed");
  assert.equal(f.launches.length, 1);
});

test("verification reads an opened receipt safely while its pathname is atomically replaced", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-receipt-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = new VerificationRunner({ directory });
  const job = { id: "fixture", startedAt: new Date().toISOString() };
  const folder = runner.folder(job);
  fs.mkdirSync(folder);
  const heartbeat = path.join(folder, "heartbeat.json"),
    replacement = path.join(folder, "replacement.json");
  fs.writeFileSync(heartbeat, JSON.stringify({ at: Date.now() }));
  fs.writeFileSync(replacement, JSON.stringify({ at: Date.now() }));
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    const fd = open(file, ...args);
    if (file === heartbeat && fs.existsSync(replacement))
      fs.renameSync(replacement, heartbeat);
    return fd;
  });
  assert.deepEqual(await runner.inspect(job), { status: "running" });
});
