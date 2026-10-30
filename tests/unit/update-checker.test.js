import test from "node:test";
import assert from "node:assert/strict";
import { UpdateChecker } from "../../server/application/update-checker.js";
import { pushEvent } from "../../server/features/notifications/push-validation.js";

// A checker with a manual clock: timers are recorded and fired by the test.
function checker({ plans = [], channel = "https://example.com/channel/" } = {}) {
  const timers = [],
    sent = [],
    warnings = [],
    observations = new Map();
  let checks = 0;
  const releases = {
    channel,
    check: async () => {
      const next = plans[Math.min(checks, plans.length - 1)];
      checks++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const notifications = {
    observation: (key) => observations.get(key),
    observe: (key, value) => observations.set(key, value),
    notify: async (input) => {
      pushEvent(input);
      sent.push(input);
    },
  };
  const updates = new UpdateChecker({
    releases,
    notifications,
    logger: { warn: (line) => warnings.push(line) },
    random: () => 0.5,
    setTimer: (fn, delay) => {
      const timer = { fn, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => (timer.cleared = true),
    delays: { startDelayMs: 180000, intervalMs: 86400000, jitterMs: 1000 },
  });
  // Fires the pending timer and waits for its check.
  const fire = async () => {
    const timer = timers.at(-1);
    timer.fn();
    await updates.running;
  };
  return { updates, timers, sent, warnings, fire, checks: () => checks };
}

const newer = { version: "2.13.0", upToDate: false };
const current = { version: "2.12.0", upToDate: true };

test("the first check runs once after the start delay, then once a day", async () => {
  const c = checker({ plans: [current] });
  c.updates.start();
  c.updates.start();
  assert.equal(c.timers.length, 1);
  assert.equal(c.timers[0].delay, 180500);
  assert.equal(c.checks(), 0);
  await c.fire();
  assert.equal(c.checks(), 1);
  assert.equal(c.timers.at(-1).delay, 86400500);
  await c.fire();
  assert.equal(c.checks(), 2);
  assert.equal(c.sent.length, 0);
  await c.updates.close();
  assert.equal(c.timers.at(-1).cleared, true);
});

test("a newer version pushes exactly once, however often it is found", async () => {
  const c = checker({ plans: [newer] });
  c.updates.start();
  await c.fire();
  await c.fire();
  await c.fire();
  assert.deepEqual(
    c.sent.map((notice) => [notice.kind, notice.label]),
    [["update-available", "2.13.0"]],
  );
});

test("failed checks never push and log once per failure streak", async () => {
  const offline = Object.assign(new Error("offline"), { code: "ENOTFOUND" });
  const c = checker({ plans: [offline, offline, current, offline] });
  c.updates.start();
  await c.fire();
  await c.fire();
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /ENOTFOUND/);
  await c.fire();
  await c.fire();
  assert.equal(c.warnings.length, 2);
  assert.equal(c.sent.length, 0);
  // It keeps checking daily after a failure.
  assert.equal(c.timers.at(-1).delay, 86400500);
});

test("without a release channel nothing is checked or logged", async () => {
  const c = checker({ plans: [newer], channel: "" });
  c.updates.start();
  await c.fire();
  assert.equal(c.checks(), 0);
  assert.equal(c.warnings.length, 0);
});
