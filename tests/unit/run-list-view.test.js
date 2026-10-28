import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { runListView } from "../../server/features/pipelines/run-list-view.js";

const allowed = new Set([
  "id",
  "status",
  "task",
  "pipelineName",
  "cwd",
  "projectId",
  "createdAt",
  "finishedAt",
  "currentNodeId",
  "verifyJob",
  "nodes",
]);
const nodeKeys = new Set([
  "id",
  "group",
  "status",
  "startedAt",
  "finishedAt",
  "profileSnapshot",
]);

test("property: the list view never has the execution log, actions or verdicts", () => {
  const node = fc.record(
    {
      id: fc.string(),
      group: fc.string(),
      status: fc.string(),
      startedAt: fc.string(),
      verdict: fc.anything(),
      profileSnapshot: fc.record({ name: fc.string(), prompt: fc.string() }),
    },
    { requiredKeys: [] },
  );
  const run = fc.record(
    {
      id: fc.string(),
      status: fc.string(),
      task: fc.oneof(fc.string(), fc.constant(undefined)),
      executionLog: fc.array(fc.anything()),
      actions: fc.array(fc.string()),
      verifyJob: fc.oneof(fc.constant(null), fc.record({ id: fc.string() })),
      nodes: fc.array(node, { maxLength: 4 }),
      spec: fc.anything(),
    },
    { requiredKeys: ["id"] },
  );
  fc.assert(
    fc.property(run, (input) => {
      const view = runListView(input);
      for (const key of Object.keys(view)) assert.ok(allowed.has(key), key);
      for (const item of view.nodes) {
        for (const key of Object.keys(item)) assert.ok(nodeKeys.has(key), key);
        if (item.profileSnapshot)
          assert.deepEqual(Object.keys(item.profileSnapshot), ["name"]);
      }
      assert.equal(typeof view.verifyJob, "boolean");
      assert.ok(!view.task.includes("\n"));
      assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
    }),
    { numRuns: 200 },
  );
});

test("the task keeps its first line, long enough for the table's headline", () => {
  const view = runListView({ id: "a", task: `  ${"x".repeat(900)}\nsecond` });
  assert.equal(view.task.length, 400);
  assert.equal(runListView({ id: "b" }).task, "");
});
