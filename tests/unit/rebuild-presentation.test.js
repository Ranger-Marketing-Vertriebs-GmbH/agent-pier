import test from "node:test";
import assert from "node:assert/strict";
import {
  byRecent,
  clockTime,
  latestCheck,
  roundChecks,
  similarityPercent,
  statusTone,
  stepStates,
} from "../../web/features/craft/rebuild-presentation.js";

test("a rebuild's steps mark the step it is on, all done once ready", () => {
  const states = (step, status) => stepStates(step, status).map((s) => s.state);
  assert.deepEqual(states("build", "building"), ["done", "current", "todo", "todo"]);
  assert.deepEqual(states("study", "paused"), ["current", "todo", "todo", "todo"]);
  assert.deepEqual(states("ready", "ready"), ["done", "done", "done", "done"]);
});

test("similarity reads as whole percent from a fraction or a percentage", () => {
  assert.equal(similarityPercent(0.723), 72);
  assert.equal(similarityPercent(1), 100);
  assert.equal(similarityPercent(87.6), 88);
  assert.equal(similarityPercent(null), null);
  assert.equal(similarityPercent(-1), null);
});

test("the latest check, status tones and the order of the list", () => {
  assert.equal(latestCheck([]), null);
  assert.deepEqual(latestCheck([{ name: "a", passed: true }, { passed: false }]), {
    name: null,
    passed: false,
  });
  assert.equal(statusTone("needs_you"), "waiting");
  assert.equal(statusTone("failed"), "error");
  assert.equal(statusTone("other"), "unknown");
  const items = [
    { id: "old", createdAt: "2026-11-01T00:00:00Z" },
    { id: "new", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z" },
  ];
  assert.deepEqual(
    items.sort(byRecent).map((item) => item.id),
    ["new", "old"],
  );
});

test("a stall reads as the clock time it began", () => {
  const at = "2026-11-17T21:30:00.000Z";
  assert.equal(
    clockTime(at, "en-GB"),
    new Intl.DateTimeFormat("en-GB", { timeStyle: "short" }).format(new Date(at)),
  );
});

test("checks read Craft Anything 0.6.0's names and count the latest round", () => {
  // As craft.json lists them: several checks per round, named by `check`.
  const checks = [
    { round: 1, check: "build", passed: true },
    { round: 1, check: "app-screenshot", passed: false },
  ];
  assert.deepEqual(latestCheck(checks), { name: "app-screenshot", passed: false });
  assert.deepEqual(roundChecks(checks), { passed: 1, total: 2 });
  assert.deepEqual(roundChecks([...checks, { round: 2, check: "build", passed: true }]), {
    passed: 1,
    total: 1,
  });
  assert.deepEqual(roundChecks(null), { passed: 0, total: 0 });
  // Older reports without rounds: only the latest check counts.
  assert.deepEqual(
    roundChecks([
      { name: "a", passed: false },
      { name: "b", passed: true },
    ]),
    {
      passed: 1,
      total: 1,
    },
  );
});
