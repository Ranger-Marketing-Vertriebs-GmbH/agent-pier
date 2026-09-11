import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

test("a waiting control in one session cannot delay another session's chat or terminal reads", async (t) => {
  const f = await applicationFixture(t);
  const manager = f.application.sessions;
  manager.current = async (id) => ({
    id,
    tool: "codex",
    accountId: "fixture",
    status: "running",
    createdAt: "2026-09-11",
  });
  manager.tmux = async () => "";
  for (const id of ["a-slow", "b-fast"])
    await manager.save({ id, createdAt: "2026-09-11" });
  const started = gate(),
    hold = gate(),
    delivered = gate();
  const control = manager.control("a-slow", async () => {
    started.release();
    await hold.promise;
  });
  await started.promise;
  const listing = manager.list();
  let complete = false;
  f.application.requests.list = async () => ({ requests: [] });
  f.application.requests.hasPending = () => false;
  f.application.models.guardInput = async () => {};
  f.application.bindings.resolve = async () => ({ id: "native" });
  f.application.history.queue = async () => {
    complete = true;
    delivered.release();
    return true;
  };
  const input = f.request("/api/sessions/b-fast/input", {
    method: "POST",
    body: {
      deliveryId: randomUUID(),
      deliveryScope: JSON.stringify(["b-fast", "fixture", "codex", "2026-09-11"]),
      text: "Hello",
      submit: true,
    },
  });
  try {
    await Promise.race([
      delivered.promise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    assert.equal(complete, true, "Unrelated control blocked chat input");
    assert.equal((await (await input).json()).status, "handed-off");
    assert.equal((await manager.get("b-fast")).id, "b-fast");
  } finally {
    hold.release();
    await Promise.all([control, input, listing]);
  }
});

test("a list requested after creation includes the new session despite an older pending list", async (t) => {
  const { application } = await applicationFixture(t);
  const manager = application.sessions;
  for (const id of ["a", "b"]) await manager.save({ id, createdAt: "2026-09-11" });
  const entered = gate(),
    hold = gate(),
    second = gate(),
    holdSecond = gate();
  let first = true;
  manager.current = async (id) => {
    if (id === "a" && first) {
      first = false;
      entered.release();
      await hold.promise;
    }
    if (id === "b") {
      second.release();
      await holdSecond.promise;
    }
    return manager.metadata(id);
  };
  const older = manager.list();
  await entered.promise;
  const creation = manager.serial(() =>
    manager.save({ id: "c", createdAt: "2026-09-11" }),
  );
  hold.release();
  await creation;
  await second.promise;
  const newer = manager.list();
  holdSecond.release();
  await older;
  assert.deepEqual(
    (await newer).map(({ id }) => id),
    ["a", "b", "c"],
  );
});

test("shutdown waits for all reads produced by a pending session list", async (t) => {
  const { application } = await applicationFixture(t);
  const manager = application.sessions;
  for (const id of ["a", "b"]) await manager.save({ id, createdAt: "2026-09-11" });
  const entered = gate(),
    hold = gate(),
    second = gate(),
    holdSecond = gate();
  manager.current = async (id) => {
    if (id === "a") {
      entered.release();
      await hold.promise;
    } else {
      second.release();
      await holdSecond.promise;
    }
    return manager.metadata(id);
  };
  const listing = manager.list();
  await entered.promise;
  let closed = false;
  const closing = manager.close().then(() => {
    closed = true;
  });
  hold.release();
  await second.promise;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, "Shutdown completed before the final list read");
  } finally {
    holdSecond.release();
    await Promise.all([listing, closing]);
  }
});
