import test from "node:test";
import assert from "node:assert/strict";
import { startResourceReads } from "../../web/lib/resource-reads.js";
import { apiCopy } from "../../web/lib/i18n/messages/components.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";

// The read loop behind useResource: `refresh()` and a new path start it again,
// `report` is what the hook stores as { data, error }.
function reader(fake, responses, options = {}) {
  const reports = [];
  let reads = 0;
  const start = () =>
    startResourceReads({
      read: (signal) => {
        const next = responses[Math.min(reads, responses.length - 1)];
        reads += 1;
        return next(signal);
      },
      poll: 1000,
      report: (result) => reports.push(result),
      env: fake.env,
      ...options,
    });
  return { reports, reads: () => reads, start };
}
const ok = (data) => async () => data;
const fail = (message) => async () => {
  throw new Error(message);
};
const hang = (signal) =>
  new Promise((resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason)),
  );

test("until stops polling for the latest data", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [ok({ status: "running" }), ok({ status: "done" })], {
    until: (data) => data.status === "done",
  });
  t.after(loop.start());
  await fake.advance(10_000);
  assert.equal(loop.reads(), 2);
  assert.deepEqual(loop.reports.at(-1), { data: { status: "done" } });
  assert.equal(fake.timers.size, 0);
});

test("a refresh after until starts a new loop that reads again", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [ok({ status: "done" })], {
    until: (data) => data.status === "done",
  });
  const first = loop.start();
  await fake.advance(5000);
  assert.equal(loop.reads(), 1);
  first();
  t.after(loop.start());
  await settle();
  assert.equal(loop.reads(), 2);
});

test("an error response is reported and polling continues", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [fail("Request failed (500)"), ok({ value: 1 })]);
  t.after(loop.start());
  await settle();
  assert.deepEqual(loop.reports, [{ error: "Request failed (500)" }]);
  await fake.advance(1000);
  assert.deepEqual(loop.reports.at(-1), { data: { value: 1 } });
});

test("a read past the polling deadline reports a timeout and keeps polling", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [hang, ok({ value: 2 })]);
  t.after(loop.start());
  await fake.advance(15_000);
  assert.deepEqual(loop.reports, [{ error: apiCopy.timedOut }]);
  await fake.advance(1000);
  assert.deepEqual(loop.reports.at(-1), { data: { value: 2 } });
});

test("timeoutMs shortens the deadline and reports the timeout", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [hang], { timeoutMs: 5000 });
  t.after(loop.start());
  await fake.advance(5000);
  assert.deepEqual(loop.reports, [{ error: apiCopy.timedOut }]);
});

test("hiding the tab or stopping cancels a read without a report", async () => {
  const fake = fakeEnv();
  const loop = reader(fake, [hang]);
  const stop = loop.start();
  await settle();
  fake.setHidden(true);
  await settle();
  fake.setHidden(false);
  await settle();
  stop();
  await fake.advance(20_000);
  assert.equal(loop.reads(), 2);
  assert.deepEqual(loop.reports, []);
});

test("a one-shot read reports once and stopping aborts it silently", async () => {
  const fake = fakeEnv();
  const once = reader(fake, [ok({ value: 3 })], { poll: 0 });
  once.start();
  await fake.advance(5000);
  assert.equal(once.reads(), 1);
  assert.deepEqual(once.reports, [{ data: { value: 3 } }]);
  const pending = reader(fake, [hang], { poll: 0 });
  const stop = pending.start();
  await settle();
  stop();
  await settle();
  assert.deepEqual(pending.reports, []);
});

test("a result started before a local update is dropped", async (t) => {
  const fake = fakeEnv();
  let generation = 0;
  let resolve;
  const loop = reader(fake, [() => new Promise((done) => (resolve = done))], {
    generation: () => generation,
  });
  t.after(loop.start());
  await settle();
  generation += 1;
  resolve({ stale: true });
  await settle();
  assert.deepEqual(loop.reports, []);
});
