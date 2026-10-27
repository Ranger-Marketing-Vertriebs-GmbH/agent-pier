import test from "node:test";
import assert from "node:assert/strict";
import { startVisiblePolling } from "../../web/lib/visible-polling.js";

// A fake browser: a document whose `hidden` flag the test sets, and manual timers.
function fakeEnv({ hidden = false } = {}) {
  const document = new EventTarget();
  document.hidden = hidden;
  const window = new EventTarget();
  let now = 0,
    nextId = 1;
  const timers = new Map();
  const env = {
    document,
    window,
    AbortController,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    env,
    timers,
    setHidden(value) {
      document.hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    // Fires due timers in order and lets each run's promise settle before the next.
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await settle();
        const due = [...timers].filter(([, timer]) => timer.at <= until);
        if (!due.length) break;
        due.sort((a, b) => a[1].at - b[1].at);
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = until;
      await settle();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("runs nothing while hidden and resumes once on visible", async (t) => {
  const fake = fakeEnv({ hidden: true });
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls += 1;
    },
    1000,
    fake.env,
  );
  t.after(stop);
  await fake.advance(10_000);
  assert.equal(calls, 0);
  fake.setHidden(false);
  await settle();
  assert.equal(calls, 1);
  await fake.advance(1000);
  assert.equal(calls, 2);
  await fake.advance(1000);
  assert.equal(calls, 3);
});

test("cancels the pending timer and aborts the running request on hidden", async (t) => {
  const fake = fakeEnv();
  const signals = [];
  const stop = startVisiblePolling(
    (signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
    1000,
    fake.env,
  );
  t.after(stop);
  await settle();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  fake.setHidden(true);
  await settle();
  assert.equal(signals[0].aborted, true);
  assert.equal(fake.timers.size, 0);
  await fake.advance(20_000);
  assert.equal(signals.length, 1);
});

test("a finished run while visible leaves exactly one timer, cleared on hidden", async (t) => {
  const fake = fakeEnv();
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls += 1;
    },
    1000,
    fake.env,
  );
  t.after(stop);
  await settle();
  assert.equal(calls, 1);
  assert.equal(fake.timers.size, 1);
  fake.setHidden(true);
  assert.equal(fake.timers.size, 0);
});

test("pageshow and online resume only a visible tab", async (t) => {
  const fake = fakeEnv({ hidden: true });
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls += 1;
    },
    1000,
    fake.env,
  );
  t.after(stop);
  fake.env.window.dispatchEvent(new Event("pageshow"));
  fake.env.window.dispatchEvent(new Event("online"));
  await fake.advance(5000);
  assert.equal(calls, 0);
  fake.env.document.hidden = false;
  fake.env.window.dispatchEvent(new Event("pageshow"));
  await settle();
  assert.equal(calls, 1);
  fake.env.window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(calls, 2);
});

test("disposing stops polling and removes the listeners", async () => {
  const fake = fakeEnv();
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls += 1;
    },
    1000,
    fake.env,
  );
  await settle();
  stop();
  assert.equal(fake.timers.size, 0);
  fake.setHidden(false);
  fake.env.window.dispatchEvent(new Event("pageshow"));
  await fake.advance(5000);
  assert.equal(calls, 1);
});
