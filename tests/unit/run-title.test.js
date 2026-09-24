import test from "node:test";
import assert from "node:assert/strict";
import { runTitle } from "../../web/features/pipelines/run-title.js";
import {
  runProgress,
  runProject,
  runStatusTone,
  runUpdatedAt,
  statusFilters,
} from "../../web/features/pipelines/run-presentation.js";

test("run titles use the first task line without markdown heading marks", () => {
  assert.equal(
    runTitle({ task: "## Implement   the\tfeature\nDetails follow", pipelineName: "P" }),
    "Implement the feature",
  );
  assert.equal(runTitle({ task: "  \n", pipelineName: "Pipeline" }), "Pipeline");
  assert.equal(runTitle({ task: "", pipelineName: "Pipeline" }), "Pipeline");
  assert.equal(runTitle({ pipelineName: "Pipeline" }), "Pipeline");
  assert.equal(runTitle({ task: "####### Seven marks" }), "####### Seven marks");
});

test("run titles clamp at 160 characters with an ellipsis", () => {
  const exact = "x".repeat(160);
  assert.equal(runTitle({ task: exact }), exact);
  assert.equal(runTitle({ task: "word ".repeat(80) }), "word ".repeat(31) + "wo…");
  assert.equal(runTitle({ task: "a".repeat(156) + " bcde" }), "a".repeat(156) + "…");
  assert.equal(runTitle({ task: "y".repeat(200) }), "y".repeat(157) + "…");
});

test("run presentation derives project, progress, tone and update time", () => {
  const run = {
    cwd: "/work/agent-pier/",
    status: "awaiting-human",
    currentNodeId: "b",
    createdAt: "2026-09-10T05:00:00Z",
    finishedAt: null,
    nodes: [
      { id: "a", status: "passed", finishedAt: "2026-09-10T06:00:00Z" },
      { id: "b", status: "awaiting-gate", startedAt: "2026-09-10T07:00:00Z" },
      { id: "c", status: "pending" },
    ],
  };
  assert.equal(runProject(run), "agent-pier");
  assert.equal(runProject({ cwd: "C:\\work\\repo" }), "repo");
  assert.equal(runProject({}), "");
  const progress = runProgress(run);
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
  assert.equal(progress.current.id, "b");
  assert.equal(progress.percent, 33);
  assert.deepEqual(runProgress({ nodes: [] }), {
    done: 0,
    total: 0,
    current: undefined,
    percent: 0,
  });
  assert.equal(runUpdatedAt(run), "2026-09-10T07:00:00Z");
  assert.equal(
    runUpdatedAt({ createdAt: "2026-09-10T05:00:00Z" }),
    "2026-09-10T05:00:00Z",
  );
  assert.equal(runUpdatedAt({}), "");
  assert.equal(runStatusTone("awaiting-human"), "decision");
  assert.equal(runStatusTone("running"), "running");
  assert.equal(runStatusTone("completed"), "ok");
  assert.equal(runStatusTone("failed"), "error");
  assert.equal(runStatusTone("cancelled"), "neutral");
  assert.equal(runStatusTone("unknown"), "neutral");
});

test("status filters list only statuses with runs in the design order", () => {
  assert.deepEqual(
    statusFilters({ completed: 2, running: 1, failed: 0, "awaiting-human": 3 }, ""),
    ["", "awaiting-human", "running", "completed"],
  );
  assert.deepEqual(statusFilters({ completed: 2 }, "failed"), [
    "",
    "failed",
    "completed",
  ]);
  assert.deepEqual(statusFilters(null, "cancelled"), ["", "cancelled"]);
});
