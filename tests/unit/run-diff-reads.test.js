import test from "node:test";
import assert from "node:assert/strict";
import { sharedRunDiff } from "../../web/features/pipelines/run-diff-reads.js";

// A read that counts its starts and resolves when told.
function reader() {
  const signals = [];
  let resolve;
  const read = (signal) => {
    signals.push(signal);
    return new Promise((done) => (resolve = done));
  };
  return { read, signals, resolve: (value) => resolve(value) };
}

test("two views of the same run and key share one read and its answer", async () => {
  const diff = reader();
  const a = sharedRunDiff("run-a|k0", diff.read);
  const b = sharedRunDiff("run-a|k0", diff.read);
  assert.equal(diff.signals.length, 1);
  assert.equal(a.promise, b.promise);
  diff.resolve({ fingerprint: "f1" });
  assert.deepEqual(await a.promise, { fingerprint: "f1" });
  // a view that joins after the answer gets it without a new read
  const c = sharedRunDiff("run-a|k0", diff.read);
  assert.deepEqual(await c.promise, { fingerprint: "f1" });
  assert.equal(diff.signals.length, 1);
  for (const user of [a, b, c]) user.release();
});

test("another key or run reads on its own", () => {
  const diff = reader();
  const users = [
    sharedRunDiff("run-b|k0", diff.read),
    sharedRunDiff("run-b|k1", diff.read),
    sharedRunDiff("run-c|k0", diff.read),
  ];
  assert.equal(diff.signals.length, 3);
  for (const user of users) user.release();
});

test("the read is aborted and dropped only when its last user lets go", () => {
  const diff = reader();
  const a = sharedRunDiff("run-d|k0", diff.read);
  const b = sharedRunDiff("run-d|k0", diff.read);
  a.release();
  a.release(); // a second release changes nothing
  assert.equal(diff.signals[0].aborted, false);
  b.release();
  assert.equal(diff.signals[0].aborted, true);
  // the next user reads again
  const c = sharedRunDiff("run-d|k0", diff.read);
  assert.equal(diff.signals.length, 2);
  c.release();
});
