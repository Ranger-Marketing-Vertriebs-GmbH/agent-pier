import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
test("restored pipeline history cannot execute or read original workspace evidence", async (t) => {
  const f = fixture(t);
  const started = await f.engine.start({
    pipelineId: "definition",
    cwd: f.dir,
    task: "history",
  });
  const run = f.engine.store.get(started.id);
  run.status = "cancelled";
  run.imported = {
    historyOnly: true,
    originalStatus: "running",
    restoredAt: new Date().toISOString(),
  };
  run.workspace = null;
  run.activeTurn = null;
  run.verifyJob = null;
  f.engine.store.save(run);
  assert.deepEqual(f.engine.get(run.id).actions, ["delete"]);
  const conflict = (error) =>
    error.status === 409 && /imported.*history/i.test(error.message);
  for (const method of ["cancel", "retry", "createPr"])
    await assert.rejects(f.engine[method](run.id), conflict);
  await assert.rejects(f.engine.gate(run.id, { action: "accept" }), conflict);
  assert.throws(() => f.engine.verdictStatus(run.id), conflict);
  assert.throws(() => f.engine.artifact(run.id, "build", "anything.txt"), conflict);
  await assert.rejects(async () => f.engine.diff(run.id, "build"), conflict);
  assert.deepEqual(f.engine.artifacts(run.id, "build"), { artifacts: [] });
  await f.engine.recover();
  assert.equal(f.launches.length, 1);
  await f.engine.delete(run.id);
  assert.equal(f.engine.list().total, 0);
});
