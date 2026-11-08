import test from "node:test";
import assert from "node:assert/strict";
import {
  byRecent,
  latestCheck,
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
