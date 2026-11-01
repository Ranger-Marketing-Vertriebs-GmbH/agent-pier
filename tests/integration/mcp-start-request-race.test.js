import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers/mcp-pipeline-fixture.js";
import { McpTools } from "../../server/features/mcp/tool-service.js";
import { projectScope } from "../../server/features/memory/project-scope.js";

// Duplicate starts with one request ID share one durable run however fast the
// project check answers: here it answers at once, so every call resumes in the same
// event-loop turn (a spawned Git used to keep them apart).
async function immediateTools(t) {
  const c = await setup(t);
  const current = await projectScope(c.app.project);
  const tools = new McpTools(c.services, { scope: async () => current });
  t.after(() => tools.close());
  const input = {
    pipelineId: c.pipeline.id,
    projectId: c.project.id,
    task: "test",
    requestId: "same-request",
  };
  return { ...c, tools, input };
}

test("concurrent run_start calls with one request ID return one run", async (t) => {
  const c = await immediateTools(t);
  const results = await Promise.all(
    Array.from({ length: 3 }, () => c.tools.call("run_start", c.input, c.grant)),
  );
  assert.deepEqual(new Set(results.map((result) => result.run.id)).size, 1);
  assert.deepEqual(
    results.map((result) => result.replayed),
    [false, true, true],
  );
  assert.equal(c.launches.length, 1);
  assert.equal(c.services.pipelines.store.all().length, 1);
  // A different start under the same request ID is still refused.
  await assert.rejects(
    c.tools.call("run_start", { ...c.input, task: "other" }, c.grant),
    (error) => error.status === 409,
  );
});

test("concurrent queue_add calls with one request ID queue one item", async (t) => {
  const c = await immediateTools(t);
  // Keeps the project's only slot busy, so the item stays in the queue.
  await c.services.pipelines.start({
    pipelineId: c.pipeline.id,
    cwd: c.app.project,
    task: "Busy",
  });
  const results = await Promise.all(
    Array.from({ length: 3 }, () => c.tools.call("queue_add", c.input, c.grant)),
  );
  assert.equal(new Set(results.map((result) => result.item.id)).size, 1);
  assert.deepEqual(
    results.map((result) => result.replayed),
    [false, true, true],
  );
  assert.equal(c.services.pipelineQueue.view(c.project.id).items.length, 1);
});
