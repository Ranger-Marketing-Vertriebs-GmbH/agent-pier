import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { PathLocks } from "../../server/features/files/file-locks.js";

const deferred = () => Promise.withResolvers();

test("parent and child locks exclude each other and overlapping waiters stay fair", async () => {
  const locks = new PathLocks(),
    release = deferred(),
    entered = deferred();
  const order = [];
  const first = locks.withPaths(["/a/child"], async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const parent = locks.withPaths(["/a"], () => order.push("parent"));
  const child = locks.withPaths(["/a/other"], () => order.push("child"));
  await locks.withPaths(["/ab"], () => order.push("independent"));
  assert.deepEqual(order, ["independent"]);
  release.resolve();
  await Promise.all([first, parent, child]);
  assert.deepEqual(order, ["independent", "parent", "child"]);
});

test("queued lock cancellation and thrown actions release waiters", async () => {
  const locks = new PathLocks(),
    release = deferred(),
    entered = deferred();
  const first = locks.withPaths(["/a"], async () => {
    entered.resolve();
    await release.promise;
    throw Error("fixture");
  });
  await entered.promise;
  const abort = new AbortController();
  const waiting = locks.withPaths(
    ["/a/b"],
    () => assert.fail("cancelled waiter ran"),
    abort.signal,
  );
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  release.resolve();
  await assert.rejects(first, /fixture/);
  await locks.withPaths(["/a"], () => {});
});

test("nested covering leases reuse safely and cannot grow or outlive the holder", async () => {
  const locks = new PathLocks(),
    detached = deferred(),
    resumed = deferred();
  let late;
  await locks.withPaths(["/a"], async () => {
    await locks.withPaths(["/a/b"], () => {});
    await assert.rejects(
      locks.withPaths(["/"], () => {}),
      /enlarge/,
    );
    late = (async () => {
      await detached.promise;
      await locks.withPaths(["/a/b"], () => resumed.resolve());
    })();
  });
  const release = deferred(),
    entered = deferred();
  const holder = locks.withPaths(["/a"], async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  detached.resolve();
  await tick();
  let done = false;
  resumed.promise.then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  release.resolve();
  await Promise.all([holder, late]);
});
