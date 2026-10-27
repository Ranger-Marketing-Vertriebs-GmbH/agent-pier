import test from "node:test";
import assert from "node:assert/strict";
import { toolPollDelay } from "../../web/features/tools/tool-installation-poll.js";

test("a running job polls every 1.5 s", () => {
  assert.equal(toolPollDelay({ job: { status: "running" } }), 1500);
});

test("busy or submitting polls even without a job", () => {
  assert.equal(toolPollDelay({ job: null, busy: true }), 1500);
  assert.equal(toolPollDelay({ job: null, submitting: true }), 1500);
});

test("an idle or finished installation stops polling", () => {
  assert.equal(toolPollDelay({ job: { status: "succeeded" }, busy: false }), null);
  assert.equal(toolPollDelay({ job: { status: "idle" } }), null);
  assert.equal(toolPollDelay({ job: { status: "failed" }, submitting: false }), null);
  assert.equal(toolPollDelay({ job: null }), null);
});
