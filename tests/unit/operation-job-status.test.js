import test from "node:test";
import assert from "node:assert/strict";
import { terminalJob } from "../../web/features/operations/operation-job-status.js";

test("a job ends with succeeded, failed or interrupted", () => {
  assert.equal(terminalJob({ status: "succeeded" }), true);
  assert.equal(terminalJob({ status: "failed" }), true);
  assert.equal(terminalJob({ status: "interrupted" }), true);
});

test("a running, queued or missing job keeps polling", () => {
  assert.equal(terminalJob({ status: "running" }), false);
  assert.equal(terminalJob({ status: "queued" }), false);
  assert.equal(terminalJob(undefined), false);
  assert.equal(terminalJob({}), false);
});
