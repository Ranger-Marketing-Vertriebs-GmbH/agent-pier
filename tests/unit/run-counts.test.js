import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { RUN_STATUSES, RunCounts } from "../../server/features/pipelines/run-counts.js";

// The reference: a full scan of the runs that exist, as GET /api/pipeline-runs?status=
// counts them (one total per status, optionally of one project).
function scan(runs, projectId) {
  const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0]));
  for (const run of runs.values())
    if ((!projectId || run.projectId === projectId) && Object.hasOwn(counts, run.status))
      counts[run.status] += 1;
  return counts;
}

test("counts start at zero for every status", () => {
  const counts = new RunCounts();
  assert.deepEqual(counts.counts(), scan(new Map()));
  assert.deepEqual(counts.counts("p1"), scan(new Map()));
});

test("rebuild counts one full scan, observe and forget follow each change", () => {
  const counts = new RunCounts();
  counts.rebuild([
    { id: "a", projectId: "p1", status: "running" },
    { id: "b", projectId: "p2", status: "failed" },
    { id: "c", projectId: null, status: "running" },
  ]);
  assert.equal(counts.counts().running, 2);
  assert.equal(counts.counts("p1").running, 1);
  assert.equal(counts.counts("p2").failed, 1);
  // A run that moves to another project and status leaves its old place.
  assert.deepEqual(counts.observe({ id: "a", projectId: "p2", status: "completed" }), {
    projectId: "p1",
    status: "running",
  });
  assert.equal(counts.counts("p1").running, 0);
  assert.equal(counts.counts("p2").completed, 1);
  assert.deepEqual(counts.forget("b"), { projectId: "p2", status: "failed" });
  assert.equal(counts.forget("b"), null);
  assert.equal(counts.counts().failed, 0);
  assert.equal(counts.observe({ id: "new", projectId: "p3", status: "running" }), null);
  assert.equal(counts.counts().running, 2);
  // An unknown status is kept out of the counts, like the REST filter refuses it.
  counts.observe({ id: "odd", projectId: "p3", status: "paused" });
  assert.deepEqual(Object.keys(counts.counts("p3")).sort(), [...RUN_STATUSES].sort());
  // A copy: changing the answer changes nothing inside.
  counts.counts().running = 99;
  assert.equal(counts.counts().running, 2);
});

test("property: counts equal a full scan after any sequence of changes", () => {
  const id = fc.constantFrom("r1", "r2", "r3", "r4", "r5");
  const project = fc.constantFrom(null, "p1", "p2", "p3");
  const status = fc.constantFrom(...RUN_STATUSES, "paused");
  const change = fc.oneof(
    fc.record({ kind: fc.constant("observe"), id, projectId: project, status }),
    fc.record({ kind: fc.constant("forget"), id }),
  );
  const initial = fc.array(fc.record({ id, projectId: project, status }), {
    maxLength: 6,
  });
  fc.assert(
    fc.property(initial, fc.array(change, { maxLength: 40 }), (start, changes) => {
      const runs = new Map(start.map((run) => [run.id, run]));
      const counts = new RunCounts();
      counts.rebuild([...runs.values()]);
      for (const { kind, ...run } of changes) {
        if (kind === "forget") {
          const before = runs.get(run.id);
          const removed = counts.forget(run.id);
          assert.deepEqual(
            removed,
            before ? { projectId: before.projectId, status: before.status } : null,
          );
          runs.delete(run.id);
        } else {
          counts.observe(run);
          runs.set(run.id, run);
        }
      }
      assert.deepEqual(counts.counts(), scan(runs));
      for (const projectId of ["p1", "p2", "p3"])
        assert.deepEqual(counts.counts(projectId), scan(runs, projectId));
    }),
    { numRuns: 300 },
  );
});
