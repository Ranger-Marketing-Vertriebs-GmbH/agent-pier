import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";

for (const reason of ["verdict-missing", "verdict-invalid"])
  test(`${reason} override retains the configured PR effect`, async (t) => {
    const f = fixture(t);
    const { graph } = f.definitions.snapshot().pipeline;
    graph.nodes.push({ id: "pr", kind: "createPr" });
    graph.edges.push({ from: "build", to: "pr", condition: "default" });
    let published = 0;
    f.workspace.createPr = async () => {
      published++;
      return { url: "https://github.example/fixture/repo/pull/1" };
    };
    const run = await f.engine.start({
      pipelineId: "definition",
      cwd: f.dir,
      task: "Task",
    });
    for (let i = 0; i < 3; i++) {
      if (reason === "verdict-invalid")
        await f.end({}, { nativeId: "native", quiesced: true });
      else {
        f.outcomes.set(f.launches.at(-1).sessionId, {
          status: "completed",
          exitCode: 0,
          nativeId: "native",
          quiesced: true,
        });
        await f.engine.reconcile();
      }
    }
    assert.equal(f.engine.get(run.id).nodes[0].failReason, reason);
    await f.engine.gate(run.id, { action: "override" });
    const completed = f.engine.get(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.pullRequestUrl, "https://github.example/fixture/repo/pull/1");
    assert.equal(published, 1);
    assert.equal(completed.nodes[0].gateDecision, "overridden");
  });
