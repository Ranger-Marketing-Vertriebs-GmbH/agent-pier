import test from "node:test";
import assert from "node:assert/strict";
import { pipelineTiming } from "../../server/features/pipelines/pipeline-timing.js";

test("pipeline timing reads bounded operator settings and keeps defaults otherwise", () => {
  assert.deepEqual(pipelineTiming(undefined), {});
  assert.deepEqual(
    pipelineTiming({
      completionGraceSeconds: 45,
      inactivityTimeoutMinutes: 30,
      turnTimeoutMinutes: 0,
    }),
    { completionGraceMs: 45000, inactivityTimeoutMs: 1800000, turnTimeoutMs: 0 },
  );
  assert.deepEqual(
    pipelineTiming({
      completionGraceSeconds: 1,
      inactivityTimeoutMinutes: "30",
      turnTimeoutMinutes: 99999,
    }),
    {},
  );
});

test("the former stageTimeoutMinutes key still configures the turn timeout", () => {
  assert.deepEqual(pipelineTiming({ stageTimeoutMinutes: 0 }), { turnTimeoutMs: 0 });
  assert.deepEqual(pipelineTiming({ stageTimeoutMinutes: 30 }), {
    turnTimeoutMs: 1800000,
  });
  assert.deepEqual(pipelineTiming({ stageTimeoutMinutes: 30, turnTimeoutMinutes: 10 }), {
    turnTimeoutMs: 600000,
  });
});
