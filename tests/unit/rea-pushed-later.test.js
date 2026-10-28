import test from "node:test";
import assert from "node:assert/strict";
import { pushedLater } from "../../web/features/tools/useRea.js";

// An action's answer must not cover a REA state pushed after it was computed.
test("a pushed REA state later than an action's answer is kept", () => {
  const running = { status: "running", jobCount: 3 };
  // A job that failed fast: its end was pushed before the start's answer.
  assert.equal(pushedLater({ status: "failed", jobCount: 3 }, running), true);
  // A later job was pushed already.
  assert.equal(pushedLater({ status: "running", jobCount: 4 }, running), true);
  // The answer is newer: a step of its job, an earlier job, the end an uninstall
  // answers after its run, or a state without job counts.
  assert.equal(pushedLater({ status: "running", jobCount: 3 }, running), false);
  assert.equal(pushedLater({ status: "succeeded", jobCount: 2 }, running), false);
  assert.equal(
    pushedLater({ status: "running", jobCount: 3 }, { status: "idle", jobCount: 3 }),
    false,
  );
  assert.equal(pushedLater(null, running), false);
  assert.equal(pushedLater({ status: "failed" }, running), false);
});
