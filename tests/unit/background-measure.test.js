import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundMeasure } from "../../server/features/system-status/background-measure.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(maxAgeMs = 1000) {
  let time = 0;
  const runs = [];
  const errors = [];
  const measure = new BackgroundMeasure({
    measure: () => {
      const run = deferred();
      runs.push(run);
      return run.promise;
    },
    maxAgeMs,
    now: () => time,
    onError: (error) => errors.push(error),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { measure, runs, errors, settle, advance: (ms) => (time += ms) };
}

test("the first read is pending and starts one measurement in the background", async () => {
  const { measure, runs, settle } = fixture();
  assert.deepEqual(measure.read(), { state: "pending" });
  assert.deepEqual(measure.read(), { state: "pending" });
  await settle();
  assert.equal(runs.length, 1, "a running measurement is never started twice");
  runs[0].resolve({ bytes: 5 });
  await settle();
  assert.deepEqual(measure.read(), { state: "ready", bytes: 5 });
  await settle();
  assert.equal(runs.length, 1, "a fresh result is cached");
});

test("an old result is measured again and shown as refreshing meanwhile", async () => {
  const { measure, runs, settle, advance } = fixture(1000);
  measure.read();
  await settle();
  runs[0].resolve({ bytes: 5 });
  await settle();
  advance(999);
  assert.equal(measure.read().state, "ready");
  advance(1);
  assert.deepEqual(measure.read(), { state: "refreshing", bytes: 5 });
  await settle();
  assert.equal(runs.length, 2);
  runs[1].resolve({ bytes: 7 });
  await settle();
  assert.deepEqual(measure.read(), { state: "ready", bytes: 7 });
});

test("invalidate measures again on the next read, also during a measurement", async () => {
  const { measure, runs, settle } = fixture();
  measure.read();
  await settle();
  runs[0].resolve({ bytes: 5 });
  await settle();
  measure.invalidate();
  assert.equal(measure.read().state, "refreshing");
  await settle();
  // A deletion while the second measurement runs: its result may predate it.
  measure.invalidate();
  runs[1].resolve({ bytes: 4 });
  await settle();
  assert.deepEqual(measure.read(), { state: "refreshing", bytes: 4 });
  await settle();
  assert.equal(runs.length, 3);
});

test("a failed measurement is reported as failed and retried only after a delay", async () => {
  const { measure, runs, errors, settle, advance } = fixture(1000);
  measure.read();
  await settle();
  runs[0].reject(new Error("unreadable"));
  await settle();
  assert.equal(errors.length, 1);
  // Every poll in the retry delay answers at once without measuring again.
  for (let poll = 0; poll < 3; poll++) {
    advance(200);
    assert.deepEqual(measure.read(), { state: "failed" });
    await settle();
  }
  assert.equal(runs.length, 1);
  advance(400);
  assert.deepEqual(measure.read(), { state: "pending" });
  await settle();
  assert.equal(runs.length, 2, "tried again after the delay");
  runs[1].resolve({ bytes: 7 });
  await settle();
  assert.deepEqual(measure.read(), { state: "ready", bytes: 7 });
});

test("a failed refresh keeps the previous result and waits before trying again", async () => {
  const { measure, runs, settle, advance } = fixture(1000);
  measure.read();
  await settle();
  runs[0].resolve({ bytes: 5 });
  await settle();
  advance(1000);
  measure.read();
  await settle();
  runs[1].reject(new Error("unreadable"));
  await settle();
  assert.deepEqual(measure.read(), { state: "ready", bytes: 5 });
  await settle();
  assert.equal(runs.length, 2);
  // A deletion still measures again at once.
  measure.invalidate();
  measure.read();
  await settle();
  assert.equal(runs.length, 3);
});

test("close waits for the running measurement and starts no other", async () => {
  const { measure, runs, settle } = fixture();
  measure.read();
  await settle();
  const closed = measure.close();
  runs[0].resolve({ bytes: 1 });
  await closed;
  assert.deepEqual(measure.read(), { state: "pending" });
  await settle();
  assert.equal(runs.length, 1);
});
