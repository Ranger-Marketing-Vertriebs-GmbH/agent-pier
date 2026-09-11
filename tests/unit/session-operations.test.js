import test from "node:test";
import assert from "node:assert/strict";
import { SessionOperations } from "../../server/features/sessions/session-operations.js";

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("session FIFO preserves input order while other sessions progress", async () => {
  const queue = new SessionOperations(() => Promise.resolve());
  const hold = gate(),
    started = gate(),
    order = [];
  const first = queue.run(async () => {
    started.release();
    await hold.promise;
    order.push("first");
  }, "a");
  await started.promise;
  const second = queue.run(() => order.push("second"), "a");
  try {
    await queue.run(() => order.push("other"), "b");
    assert.deepEqual(order, ["other"]);
  } finally {
    hold.release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(order, ["other", "first", "second"]);
  await queue.drain();
  assert.equal(queue.sessions.size, 0);
});

test("creation/replacement barriers drain earlier sessions and hold later input", async () => {
  const queue = new SessionOperations(() => Promise.resolve());
  const hold = gate(),
    started = gate(),
    exclusive = gate(),
    entered = gate();
  const order = [];
  const first = queue.run(async () => {
    started.release();
    await hold.promise;
    order.push("earlier");
  }, "a");
  await started.promise;
  const barrier = queue.run(async () => {
    order.push("replace");
    entered.release();
    await exclusive.promise;
  });
  const later = queue.run(() => order.push("later"), "b");
  let drained = false;
  const draining = queue.drain().then(() => {
    drained = true;
  });
  try {
    assert.deepEqual(order, []);
    hold.release();
    await entered.promise;
    assert.deepEqual(order, ["earlier", "replace"]);
    assert.equal(drained, false);
  } finally {
    hold.release();
    exclusive.release();
    await Promise.all([first, barrier, later, draining]);
  }
  assert.deepEqual(order, ["earlier", "replace", "later"]);
  assert.equal(drained, true);
});

test("failed session and exclusive operations release subsequent work", async () => {
  const queue = new SessionOperations(() => Promise.resolve());
  await assert.rejects(
    queue.run(() => {
      throw Error("session");
    }, "a"),
  );
  await assert.rejects(
    queue.run(() => {
      throw Error("exclusive");
    }),
  );
  assert.equal(await queue.run(() => "ok", "a"), "ok");
  await queue.drain();
});
