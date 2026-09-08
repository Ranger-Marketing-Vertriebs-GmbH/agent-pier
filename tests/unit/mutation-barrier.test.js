import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
const module = await import("../../server/application/mutation-barrier.js").catch(
  () => ({}),
);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test("snapshot drains active mutations and holds later mutations until capture ends", async () => {
  assert.equal(typeof module.MutationBarrier, "function");
  const gate = new module.MutationBarrier(),
    active = deferred(),
    started = deferred(),
    capture = deferred(),
    captured = deferred(),
    order = [];
  const first = gate.run(async () => {
    order.push("first");
    started.resolve();
    await active.promise;
    order.push("first-end");
  });
  await started.promise;
  const snapshot = gate.snapshot(async () => {
    order.push("snapshot");
    captured.resolve();
    await capture.promise;
    order.push("snapshot-end");
  });
  const later = gate.run(() => {
    order.push("later");
  });
  assert.deepEqual(order, ["first"]);
  active.resolve();
  await captured.promise;
  assert.deepEqual(order, ["first", "first-end", "snapshot"]);
  capture.resolve();
  await Promise.all([first, snapshot, later]);
  assert.deepEqual(order, ["first", "first-end", "snapshot", "snapshot-end", "later"]);
});
test("nested native operations retain their mutation lease and errors always release it", async () => {
  assert.equal(typeof module.MutationBarrier, "function");
  const gate = new module.MutationBarrier();
  await assert.rejects(
    gate.run(() =>
      gate.run(() => {
        throw Error("fixture");
      }),
    ),
    /fixture/,
  );
  assert.equal(await gate.snapshot(() => 42), 42);
  await assert.rejects(
    gate.run(() => gate.snapshot(() => 42)),
    /upgrade/i,
  );
  assert.equal(await gate.run(() => 7), 7);
});
test("a background callback cannot reuse an already released asynchronous mutation context", async () => {
  const gate = new module.MutationBarrier(),
    trigger = deferred(),
    scheduled = deferred(),
    capturing = deferred(),
    captured = deferred();
  let background,
    ran = false;
  await gate.run(() => {
    background = (async () => {
      scheduled.resolve();
      await trigger.promise;
      await gate.run(() => {
        ran = true;
      });
    })();
  });
  await scheduled.promise;
  const snapshot = gate.snapshot(async () => {
    captured.resolve();
    await capturing.promise;
  });
  await captured.promise;
  trigger.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  capturing.resolve();
  await Promise.all([snapshot, background]);
  assert.equal(ran, true);
});
test("a disconnected HTTP client does not release a still-running mutation before its write completes", async (t) => {
  assert.equal(typeof module.guardMutations, "function");
  const gate = new module.MutationBarrier(),
    app = express(),
    router = express.Router();
  const started = deferred(),
    finish = deferred(),
    disconnected = deferred();
  let written = false,
    captured = false;
  router.post("/write", async (_req, res) => {
    res.once("close", () => disconnected.resolve());
    started.resolve();
    await finish.promise;
    written = true;
    res.json({ ok: true });
  });
  app.use(module.guardMutations(router, gate));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        finish.resolve();
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.address().port}/write`, {
    method: "POST",
    signal: controller.signal,
  }).catch(() => null);
  await started.promise;
  controller.abort();
  await disconnected.promise;
  await request;
  const snapshot = gate.snapshot(() => {
    captured = true;
    assert.equal(written, true);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured, false);
  finish.resolve();
  await snapshot;
});
