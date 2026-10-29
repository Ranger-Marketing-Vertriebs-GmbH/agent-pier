import test from "node:test";
import assert from "node:assert/strict";
import { startResourceReads } from "../../web/lib/resource-reads.js";
import { apiCopy } from "../../web/lib/i18n/messages/components.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";

// The one read behind useResource: `refresh()` and a new path start it again,
// `report` is what the hook stores as { data, error }. It never polls.
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

test("a read reports once and never reads again by itself", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [ok({ value: 3 })]);
  t.after(loop.start());
  await fake.advance(60_000);
  assert.equal(loop.reads(), 1);
  assert.deepEqual(loop.reports, [{ data: { value: 3 } }]);
  assert.equal(fake.timers.size, 0);
});

test("an error response is reported", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [fail("Request failed (500)")]);
  t.after(loop.start());
  await settle();
  assert.deepEqual(loop.reports, [{ error: "Request failed (500)" }]);
});

test("timeoutMs ends a hung read with a timeout error", async (t) => {
  const fake = fakeEnv();
  const loop = reader(fake, [hang], { timeoutMs: 5000 });
  t.after(loop.start());
  await fake.advance(5000);
  assert.deepEqual(loop.reports, [{ error: apiCopy.timedOut, timedOut: true }]);
});

test("stopping aborts a read silently", async () => {
  const fake = fakeEnv();
  const pending = reader(fake, [hang]);
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
