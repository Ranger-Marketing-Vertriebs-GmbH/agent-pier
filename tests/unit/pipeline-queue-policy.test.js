import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  defaultQueueSettings,
  holdsSlot,
  itemsToStart,
  occupiedSlots,
  storedQueueSettings,
  validateQueueSettings,
} from "../../server/features/pipelines/queue-policy.js";

const settings = (limit = 1, countParked = false) => ({ limit, countParked });
const item = (id, position, state = "queued") => ({ id, position, state });
const run = (id, status, extra = {}) => ({ id, status, projectId: "p", ...extra });

test("queue settings default to one run and accept only whole limits from 1 to 20", () => {
  assert.deepEqual(defaultQueueSettings(), { limit: 1, countParked: false });
  assert.deepEqual(validateQueueSettings({ limit: 20, countParked: true, extra: 1 }), {
    limit: 20,
    countParked: true,
  });
  for (const body of [
    null,
    {},
    { limit: 0, countParked: false },
    { limit: 21, countParked: false },
    { limit: 1.5, countParked: false },
    { limit: "2", countParked: false },
    { limit: 2, countParked: "yes" },
  ])
    assert.throws(() => validateQueueSettings(body), { status: 400 });
  // Restored or hand-edited values never block the queue; they use the defaults.
  assert.deepEqual(storedQueueSettings({ limit: 99 }), defaultQueueSettings());
  assert.deepEqual(
    storedQueueSettings({ limit: 3, countParked: true }),
    settings(3, true),
  );
});

test("running runs hold a slot, waiting runs only when they count or wait for a reset", () => {
  assert.equal(holdsSlot(run("a", "running"), settings()), true);
  assert.equal(holdsSlot(run("a", "awaiting-human"), settings()), false);
  assert.equal(holdsSlot(run("a", "awaiting-human"), settings(1, true)), true);
  // A usage limit resumes on its own; starting another run would hit it as well.
  const usage = run("a", "awaiting-human", { usageResumeAt: "2026-10-20T12:00:00Z" });
  assert.equal(holdsSlot(usage, settings()), true);
  for (const status of ["completed", "failed", "cancelled"])
    assert.equal(holdsSlot(run("a", status), settings(1, true)), false);
});

test("occupied slots count the project's runs, queue runs and starts without a run", () => {
  const items = [item("q1", 1, "started"), item("q2", 2, "starting"), item("q3", 3)];
  const runs = [
    run("manual", "running"),
    run("other", "running", { projectId: "elsewhere" }),
    // Still provisioning: the project is only expected, or known through the queue.
    run("pending", "running", { projectId: null, expectedProjectId: "p" }),
    run("q1", "running", { projectId: null }),
    run("parked", "awaiting-human"),
  ];
  const count = (countParked) =>
    occupiedSlots({ projectId: "p", items, runs, settings: settings(9, countParked) });
  // manual, pending, q1 and the start of q2 that has no run yet.
  assert.equal(count(false), 4);
  assert.equal(count(true), 5);
});

test("the next items start in queue order up to the free slots", () => {
  const items = [item("c", 3), item("a", 1), item("f", 2, "failed"), item("b", 2)];
  const start = (limit, runs = []) =>
    itemsToStart({ projectId: "p", items, runs, settings: settings(limit) }).map(
      (i) => i.id,
    );
  assert.deepEqual(start(1), ["a"]);
  assert.deepEqual(start(2), ["a", "b"]);
  assert.deepEqual(start(5), ["a", "b", "c"]);
  assert.deepEqual(start(1, [run("busy", "running")]), []);
  assert.deepEqual(start(2, [run("busy", "running")]), ["a"]);
  // A parked run frees its slot unless the project counts it.
  assert.deepEqual(start(1, [run("parked", "awaiting-human")]), ["a"]);
});

test("property: scheduling never exceeds the limit and keeps queue order", () => {
  const states = fc.constantFrom("queued", "starting", "started", "failed");
  const statuses = fc.constantFrom(
    "running",
    "awaiting-human",
    "completed",
    "failed",
    "cancelled",
  );
  fc.assert(
    fc.property(
      fc.array(fc.tuple(states, fc.integer({ min: 1, max: 1000 })), { maxLength: 30 }),
      fc.array(fc.tuple(statuses, fc.boolean()), { maxLength: 30 }),
      fc.integer({ min: 1, max: 20 }),
      fc.boolean(),
      (rawItems, rawRuns, limit, countParked) => {
        const items = rawItems.map(([state, position], i) =>
          item(`i${i}`, position, state),
        );
        const runs = rawRuns.map(([status, mine], i) =>
          run(`r${i}`, status, { projectId: mine ? "p" : "q" }),
        );
        const context = {
          projectId: "p",
          items,
          runs,
          settings: settings(limit, countParked),
        };
        const chosen = itemsToStart(context);
        const occupied = occupiedSlots(context);
        assert.ok(chosen.length <= Math.max(0, limit - occupied));
        assert.ok(chosen.every((i) => i.state === "queued"));
        const positions = chosen.map((i) => i.position);
        assert.deepEqual(
          positions,
          [...positions].sort((a, b) => a - b),
        );
        // Every queued item that was passed over sits behind the chosen ones.
        const last = positions.at(-1) ?? -Infinity;
        const skipped = items.filter((i) => i.state === "queued" && !chosen.includes(i));
        if (chosen.length === Math.max(0, limit - occupied))
          assert.ok(skipped.every((i) => i.position >= last));
        else assert.equal(skipped.length, 0);
      },
    ),
  );
});
