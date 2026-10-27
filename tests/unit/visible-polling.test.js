import test from "node:test";
import assert from "node:assert/strict";
import { startVisiblePolling } from "../../web/lib/visible-polling.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";

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

test("a read past the deadline is aborted as a timeout, hiding is not", async (t) => {
  const fake = fakeEnv();
  const signals = [];
  const stop = startVisiblePolling(
    (signal) => {
      signals.push(signal);
      return new Promise((resolve) => signal.addEventListener("abort", resolve));
    },
    1000,
    fake.env,
  );
  t.after(stop);
  await fake.advance(15_000);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[0].reason.name, "TimeoutError");
  await fake.advance(1000);
  assert.equal(signals.length, 2);
  fake.setHidden(true);
  assert.equal(signals[1].aborted, true);
  assert.notEqual(signals[1].reason.name, "TimeoutError");
});

test("skipFirst skips the start run while visible, then polls on the interval", async (t) => {
  const fake = fakeEnv({});
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls += 1;
    },
    1000,
    fake.env,
    { skipFirst: true },
  );
  t.after(stop);
  await settle();
  assert.equal(calls, 0);
  await fake.advance(1000);
  assert.equal(calls, 1);
});

test("skipFirst never skips the run when a hidden start becomes visible", async (t) => {
  const fake = fakeEnv({ hidden: true });
  let calls = 0;
  const stop = startVisiblePolling(
    async () => {
      calls += 1;
    },
    1000,
    fake.env,
    { skipFirst: true },
  );
  t.after(stop);
  await fake.advance(5000);
  assert.equal(calls, 0);
  fake.setHidden(false);
  await settle();
  assert.equal(calls, 1);
});
