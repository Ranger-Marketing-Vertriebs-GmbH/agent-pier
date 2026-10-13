import test from "node:test";
import assert from "node:assert/strict";
import {
  attentionTarget,
  hintCount,
  projectAttention,
} from "../../web/features/projects/project-presentation.js";

const attention = {
  decisions: { m1: 1, m2: 3 },
  failed: { m2: 2 },
  first: { decisions: { m1: "run-a", m2: "run-b" }, failed: { m2: "run-f" } },
  capped: { decisions: false, failed: true },
};

test("a project's attention parts carry count, first run and the capped flag", () => {
  assert.deepEqual(projectAttention(attention, "m1"), {
    decisions: { count: 1, run: "run-a", capped: false },
    failed: { count: 0, run: "", capped: true },
  });
  assert.deepEqual(projectAttention(attention, ""), {
    decisions: { count: 0, run: "", capped: false },
    failed: { count: 0, run: "", capped: true },
  });
  assert.deepEqual(
    projectAttention({ decisions: {}, failed: {}, capped: {} }, "m1").decisions,
    { count: 0, run: "", capped: false },
  );
});

test("one known run opens that run; several or a capped count open the filtered list", () => {
  assert.deepEqual(
    attentionTarget("p1", "awaiting-human", { count: 1, run: "run-a", capped: false }),
    {
      view: "pipelines",
      pipelineTab: "runs",
      pipelineItem: "run-a",
      pipelinePage: 1,
      pipelineStatus: "",
      projectId: "",
    },
  );
  for (const part of [
    { count: 3, run: "run-b", capped: false },
    { count: 1, run: "run-f", capped: true },
    { count: 1, run: "", capped: false },
  ]) {
    const target = attentionTarget("p1", "failed", part);
    assert.equal(target.view, "projects");
    assert.equal(target.projectId, "p1");
    assert.equal(target.projectTab, "runs");
    assert.equal(target.pipelineStatus, "failed");
  }
});

test("capped counts read as lower bounds", () => {
  assert.equal(hintCount(100, true), "100+");
  assert.equal(hintCount(2, false), 2);
});
