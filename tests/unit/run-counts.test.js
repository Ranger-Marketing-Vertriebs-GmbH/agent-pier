import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { RUN_STATUSES, RunCounts } from "../../server/features/pipelines/run-counts.js";
import { runListView } from "../../server/features/pipelines/run-list-view.js";

// Where a run was counted, without its list digest.
const place = (entry) => entry && { projectId: entry.projectId, status: entry.status };
const totalOf = (runs, projectId) =>
  [...runs.values()].filter((run) => !projectId || run.projectId === projectId).length;

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
  assert.deepEqual(
    place(counts.observe({ id: "a", projectId: "p2", status: "completed" })),
    {
      projectId: "p1",
      status: "running",
    },
  );
  assert.equal(counts.counts("p1").running, 0);
  assert.equal(counts.counts("p2").completed, 1);
  assert.deepEqual(place(counts.forget("b")), { projectId: "p2", status: "failed" });
  assert.equal(counts.forget("b"), null);
  assert.equal(counts.counts().failed, 0);
  assert.equal(counts.observe({ id: "new", projectId: "p3", status: "running" }), null);
  assert.equal(counts.counts().running, 2);
  // An unknown status is kept out of the counts, like the REST filter refuses it.
  counts.observe({ id: "odd", projectId: "p3", status: "paused" });
  assert.deepEqual(Object.keys(counts.counts("p3")).sort(), [...RUN_STATUSES].sort());
  // ...but in the total, like the unfiltered list.
  assert.equal(counts.total("p3"), 2);
  assert.equal(counts.total(), 4);
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
            place(removed),
            before ? { projectId: before.projectId, status: before.status } : null,
          );
          if (before) assert.equal(removed.listed, JSON.stringify(runListView(before)));
          runs.delete(run.id);
        } else {
          counts.observe(run);
          runs.set(run.id, run);
        }
      }
      assert.deepEqual(counts.counts(), scan(runs));
      assert.equal(counts.total(), runs.size);
      for (const projectId of ["p1", "p2", "p3"]) {
        assert.deepEqual(counts.counts(projectId), scan(runs, projectId));
        assert.equal(counts.total(projectId), totalOf(runs, projectId));
      }
    }),
    { numRuns: 300 },
  );
});

test("the list digest changes with a listed field, not with the execution log", () => {
  const counts = new RunCounts();
  const run = {
    id: "a",
    projectId: "p1",
    status: "running",
    task: "Ship it",
    nodes: [{ id: "n1", status: "running", verdict: { summary: "x" } }],
    executionLog: [],
  };
  counts.observe(run);
  const logged = { ...run, executionLog: [{ id: "turn-1", verdict: { summary: "y" } }] };
  const unchanged = counts.observe(logged);
  assert.equal(unchanged.listed, counts.observe(logged).listed);
  const moved = { ...logged, currentNodeId: "n1" };
  assert.notEqual(counts.observe(moved).listed, JSON.stringify(runListView(moved)));
});
