import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { problem } from "../../server/lib/storage.js";
import { reopenAtStage } from "../../server/features/pipelines/return-to-stage.js";

// build -> review -> approve; a review failure loops back to build.
async function completed(t) {
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
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  for (const summary of ["Built", "Reviewed", "Approved"])
    await f.end({ result: "pass", summary, findings: [] });
  assert.equal(f.engine.get(run.id).status, "completed");
  const edit = (change) => {
    const saved = f.engine.store.get(run.id);
    change(saved);
    f.engine.store.save(saved);
  };
  const reopen = (nodeId) =>
    f.engine.lock(run.id, () =>
      reopenAtStage(f.engine, f.engine.store.get(run.id), {
        nodeId,
        note: "Again",
        requestId: `req-${nodeId}`,
      }),
    );
  const statuses = () => f.engine.get(run.id).nodes.map((n) => [n.id, n.status]);
  return { f, run, edit, reopen, statuses };
}

test("a completed run returned to its last stage runs that stage again", async (t) => {
  const { reopen, statuses } = await completed(t);
  await reopen("approve");
  assert.deepEqual(statuses(), [
    ["build", "passed"],
    ["review", "passed"],
    ["approve", "running"],
  ]);
});

test("a stage off the path to where the run stopped resets with what follows it", async (t) => {
  const { f, run, edit, reopen, statuses } = await completed(t);
  // The run stopped at build, which no path from review reaches without the loop edge.
  edit((r) => {
    r.status = "failed";
    r.currentNodeId = "build";
    r.nodes[0].status = "failed";
  });
  await reopen("review");
  assert.deepEqual(statuses(), [
    ["build", "failed"],
    ["review", "running"],
    ["approve", "pending"],
  ]);
  assert.equal(f.engine.get(run.id).nodes[2].verdict, undefined);
});

test("a pull request that is no longer open says so on the stage", async (t) => {
  const { f, run, edit, reopen } = await completed(t);
  const gone = serverMessages.pipelineWorkspaces.pullRequestNoLongerOpen;
  edit((r) => {
    r.pullRequestUrl = "https://github.com/fixture/repo/pull/1";
  });
  f.workspace.createPr = async () => {
    throw problem(gone, 409);
  };
  await reopen("approve");
  await f.end({ result: "pass", summary: "Approved again", findings: [] });
  const stage = f.engine.get(run.id).nodes[2];
  assert.equal(stage.failReason, "pr-failed");
  assert.equal(stage.failDetail, gone);
});
