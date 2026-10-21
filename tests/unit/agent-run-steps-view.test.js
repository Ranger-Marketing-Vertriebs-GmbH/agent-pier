import test from "node:test";
import assert from "node:assert/strict";
import {
  nextSteps,
  stallMs,
  stalledMinutes,
  stepsOf,
} from "../../web/features/assistants/run-steps.js";

const frame = (extra = {}) => ({
  type: "steps",
  runId: "r1",
  steps: [
    { id: "tool:1", kind: "tool", tool: "exec", label: "Suchen", state: "running" },
  ],
  omitted: 0,
  phase: "tool",
  retry: null,
  quietMs: 0,
  ...extra,
});

test("a steps frame replaces its run's view and steps-end drops it", () => {
  let runs = nextSteps(new Map(), frame(), 1000);
  assert.deepEqual(runs.get("r1").steps[0], {
    id: "tool:1",
    kind: "tool",
    tool: "exec",
    label: "Suchen",
    state: "running",
  });
  runs = nextSteps(runs, frame({ phase: "model", steps: [] }), 2000);
  assert.equal(runs.get("r1").phase, "model");
  const same = nextSteps(runs, { type: "steps-end", runId: "other" });
  assert.equal(same, runs);
  runs = nextSteps(runs, { type: "steps-end", runId: "r1" });
  assert.equal(runs.size, 0);
  assert.equal(nextSteps(runs, { type: "stream", runId: "r1" }), null);
});

test("unknown phases, states and shapes are made safe", () => {
  const runs = nextSteps(
    new Map(),
    frame({
      phase: "evil",
      steps: [{ id: "a", state: "weird" }, null, { kind: "thinking", id: "t" }],
      retry: { attempt: 2, of: 8 },
    }),
  );
  const view = runs.get("r1");
  assert.equal(view.phase, "model");
  assert.deepEqual(
    view.steps.map((s) => [s.kind, s.state]),
    [
      ["tool", "running"],
      ["thinking", "running"],
    ],
  );
  assert.deepEqual(view.retry, { attempt: 2, of: 8 });
});

test("the attempt's run is found by its runtime run or attempt id", () => {
  const runs = nextSteps(new Map(), frame());
  assert.ok(stepsOf(runs, { id: "x", runtimeRunId: "r1" }));
  assert.ok(stepsOf(runs, { id: "r1" }));
  assert.equal(stepsOf(runs, { id: "x" }), null);
  assert.equal(stepsOf(runs, null), null);
});

test("a turn waiting for the model is stalled after three quiet minutes, a tool never", () => {
  const at = 10_000_000;
  const quiet = (phase, quietMs) =>
    nextSteps(new Map(), frame({ phase, quietMs }), at).get("r1");
  assert.equal(stalledMinutes(quiet("model", stallMs - 1), at), 0);
  assert.equal(stalledMinutes(quiet("model", stallMs), at), 3);
  assert.equal(stalledMinutes(quiet("model", 0), at + 16 * 60000), 16);
  assert.equal(stalledMinutes(quiet("retrying", stallMs), at), 3);
  for (const phase of ["tool", "approval", "compacting"])
    assert.equal(stalledMinutes(quiet(phase, stallMs * 10), at), 0, phase);
  assert.equal(stalledMinutes(null, at), 0);
});
