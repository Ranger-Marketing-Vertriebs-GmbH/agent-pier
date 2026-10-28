import test from "node:test";
import assert from "node:assert/strict";
import {
  createRefreshRetry,
  firstRetryMs,
  maxRetryMs,
} from "../../web/app/refresh-retry.js";
import { workspaceStateView } from "../../web/app/workspace-state-view.js";

// Timers the test fires by hand.
function manualTimers() {
  const pending = new Map();
  let next = 0;
  return {
    setTimeout(callback, ms) {
      next += 1;
      pending.set(next, { callback, ms });
      return next;
    },
    clearTimeout: (id) => pending.delete(id),
    waits: () => [...pending.values()].map(({ ms }) => ms),
    async fire() {
      const [[id, { callback }]] = pending;
      pending.delete(id);
      await callback();
    },
  };
}

test("a failure followed by a successful retry clears the error without a push", async () => {
  const timers = manualTimers();
  // The hook's state: the topic holds a value that no push will replace (idle).
  const held = { sessions: [], readStartedAt: 100 };
  const live = { data: held, error: "", loading: false };
  let read = { basis: held, data: null, error: "Server down" };
  let answers = 0;
  const retry = createRefreshRetry({
    timers,
    attempt: async () => {
      answers += 1;
      read = { basis: held, data: { ...held, readStartedAt: 200 }, error: "" };
    },
  });
  retry.failed();
  assert.equal(workspaceStateView(live, read).failure, "Server down");
  assert.deepEqual(timers.waits(), [firstRetryMs]);
  await timers.fire();
  assert.equal(answers, 1);
  assert.equal(workspaceStateView(live, read).failure, "");
  // Done: no further retry.
  assert.deepEqual(timers.waits(), []);
  assert.equal(retry.scheduled(), null);
});

test("the backoff doubles up to 30 s and keeps one timer", async () => {
  const timers = manualTimers();
  const retry = createRefreshRetry({
    timers,
    attempt: async () => {
      throw new Error("still down");
    },
  });
  retry.failed();
  retry.failed();
  assert.deepEqual(timers.waits(), [3000]);
  const waits = [];
  for (let round = 0; round < 6; round++) {
    waits.push(...timers.waits());
    await timers.fire();
  }
  assert.deepEqual(waits, [3000, 6000, 12000, 24000, maxRetryMs, maxRetryMs]);
  assert.deepEqual(timers.waits(), [maxRetryMs]);
  // A push or a newer refresh stops it and starts over.
  retry.stop();
  assert.deepEqual(timers.waits(), []);
  retry.failed();
  assert.deepEqual(timers.waits(), [firstRetryMs]);
});

test("unmount cancels the retry, also one already running", async () => {
  const timers = manualTimers();
  let attempts = 0;
  let unmount;
  const retry = createRefreshRetry({
    timers,
    attempt: async () => {
      attempts += 1;
      unmount();
      throw new Error("down");
    },
  });
  unmount = () => retry.stop();
  retry.failed();
  retry.stop();
  assert.deepEqual(timers.waits(), []);
  assert.equal(attempts, 0);
  // Stopped while its read runs: it schedules nothing more.
  retry.failed();
  await timers.fire();
  assert.equal(attempts, 1);
  assert.deepEqual(timers.waits(), []);
});

test("no retry without a healthy channel", async () => {
  const timers = manualTimers();
  let healthy = false;
  const retry = createRefreshRetry({
    timers,
    healthy: () => healthy,
    attempt: async () => {},
  });
  retry.failed();
  assert.deepEqual(timers.waits(), []);
  healthy = true;
  retry.failed();
  healthy = false;
  await timers.fire();
  assert.deepEqual(timers.waits(), []);
});
