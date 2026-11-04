import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
import {
  reopenAtStage,
  returnableStages,
} from "../../server/features/pipelines/return-to-stage.js";

// build -> review -> approve; a review failure loops back to build.
function completedFixture(t) {
  const f = fixture(t, { loop: true });
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    snapshot.pipeline.graph = {
      entry: "build",
      nodes: ["build", "review", "approve"].map((id) => ({
        id,
        kind: "profile",
        profileId: "profile",
      })),
      edges: [
        { from: "build", to: "review", condition: "default" },
        { from: "review", to: "approve", condition: "default" },
        { from: "review", to: "build", condition: "fail", maxIterations: 1 },
      ],
    };
    return snapshot;
  };
  return f;
}
const pass = (summary) => ({ result: "pass", summary, findings: [] });

async function completed(t) {
  const f = completedFixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  await f.end(pass("Built"), { nativeId: "native-build" });
  await f.end(pass("Reviewed"), { nativeId: "native-review" });
  await f.end(pass("Approved"), { nativeId: "native-approve" });
  assert.equal(f.engine.get(run.id).status, "completed");
  const reopen = (input) =>
    f.engine.lock(run.id, () =>
      reopenAtStage(f.engine, f.engine.store.get(run.id), input),
    );
  return { f, run, reopen, current: () => f.engine.get(run.id) };
}

test("a completed run reopens at the chosen stage and later stages reset", async (t) => {
  const { f, reopen, current } = await completed(t);
  const result = await reopen({
    nodeId: "review",
    note: "Review notes (1):\n- fix it",
    requestId: "req-1",
  });
  assert.deepEqual(result, { repeated: false });
  const saved = current();
  assert.equal(saved.status, "running");
  assert.equal(saved.finishedAt, undefined);
  assert.deepEqual(
    saved.nodes.map((n) => [n.id, n.status]),
    [
      ["build", "passed"],
      ["review", "running"],
      ["approve", "pending"],
    ],
  );
  assert.match(
    f.launches.at(-1).prompt,
    /The operator sent the run back with this instruction for the repair:\n\nReview notes \(1\):/,
  );
  assert.deepEqual(
    saved.returns.map((r) => [r.requestId, r.nodeId]),
    [["req-1", "review"]],
  );
});

test("the round is recorded but no loop limit counts it", async (t) => {
  const { f, reopen, current } = await completed(t);
  const before = structuredClone(current().loopState);
  await reopen({ nodeId: "review", note: "Review notes", requestId: "req-1" });
  const saved = current();
  assert.deepEqual(saved.loopState, before);
  const round = saved.loopRounds.at(-1);
  assert.equal(round.toNodeId, "review");
  assert.equal(round.edge, "owner:approve->review");
  assert.equal(round.round, 1);
  assert.equal(saved.nodes[1].loop.maxIterations, undefined);
  assert.equal(saved.nodes[1].loop.owner, true);
  assert.doesNotMatch(f.launches.at(-1).prompt, /Repair round \d+ of/);
});

test("the stage resumes its earlier session when it can, else starts fresh", async (t) => {
  const { f, reopen, current } = await completed(t);
  await reopen({ nodeId: "review", note: "Again", requestId: "req-1" });
  assert.equal(f.launches.at(-1).kind, "resumed-repair");
  assert.equal(f.launches.at(-1).resumeNativeId, "native-review");

  const other = await completed(t);
  const run = other.f.engine.store.get(other.run.id);
  run.nodes[1].profileSnapshot = { ...run.nodes[1].profileSnapshot, id: "changed" };
  other.f.engine.store.save(run);
  await other.reopen({ nodeId: "review", note: "Again", requestId: "req-1" });
  assert.equal(other.f.launches.at(-1).kind, "kickoff");
  assert.deepEqual(other.current().executionLog.at(-1).repair, {
    edge: "owner:approve->review",
    round: 1,
    session: "fresh",
    fallback: "profile-changed",
  });
  assert.ok(current());
});

test("only stages that ran are offered; members stay out", async (t) => {
  const f = completedFixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  assert.deepEqual(
    returnableStages(f.engine.get(run.id)).map((s) => s.id),
    ["build"],
  );
  const synthetic = {
    nodes: [
      { id: "a", profileSnapshot: { name: "Alpha" } },
      { id: "g", kind: "parallel" },
      { id: "m", group: "g" },
    ],
    executionLog: [{ nodeId: "a" }, { nodeId: "g" }, { nodeId: "m" }],
  };
  assert.deepEqual(returnableStages(synthetic), [
    { id: "a", name: "Alpha" },
    { id: "g", name: "g" },
  ]);
});

test("a repeated request id reopens once and the history stays bounded", async (t) => {
  const { f, reopen, current } = await completed(t);
  await reopen({ nodeId: "review", note: "Once", requestId: "req-1" });
  const count = f.launches.length;
  const again = await reopen({ nodeId: "review", note: "Once", requestId: "req-1" });
  assert.deepEqual(again, { repeated: true });
  assert.equal(f.launches.length, count);
  assert.equal(current().returns.length, 1);
  const run = f.engine.store.get(current().id);
  run.returns = Array.from({ length: 25 }, (_, i) => ({ requestId: `r${i}` }));
  f.engine.store.save(run);
  run.status = "completed";
  await reopen({ nodeId: "review", note: "More", requestId: "new" });
  assert.equal(current().returns.length, 20);
});
