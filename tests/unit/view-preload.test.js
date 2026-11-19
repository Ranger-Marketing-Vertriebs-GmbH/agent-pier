import test from "node:test";
import assert from "node:assert/strict";
import { preloadLoaders, preloadViews, savesData } from "../../web/app/view-preload.js";

const now = (callback) => callback();

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener, options) {
      listeners.set(type, { listener, options });
    },
    fire(type) {
      const entry = listeners.get(type);
      listeners.delete(type);
      entry?.listener();
    },
    has: (type) => listeners.has(type),
  };
}

test("agent views are loaded only while agents are on", () => {
  const off = preloadLoaders({ agents: false });
  const on = preloadLoaders({ agents: true });
  assert.ok(off.length > 0);
  assert.equal(on.length, off.length + 2);
  assert.deepEqual(on.slice(0, off.length), off);
});

test("the loaders run one after another, each in its own idle period", async () => {
  const order = [];
  const scheduled = [];
  const loader = (name) => async () => {
    order.push(`start ${name}`);
    await Promise.resolve();
    order.push(`end ${name}`);
  };
  const failed = await preloadViews([loader("a"), loader("b")], {
    schedule: (callback) => {
      scheduled.push(order.length);
      callback();
    },
    saveData: false,
    target: eventTarget(),
  });
  assert.deepEqual(failed, []);
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
  assert.deepEqual(scheduled, [0, 2]);
});

test("data saver loads nothing", async () => {
  let called = false;
  const failed = await preloadViews(
    [
      async () => {
        called = true;
      },
    ],
    { schedule: now, saveData: true },
  );
  assert.deepEqual(failed, []);
  assert.equal(called, false);
  assert.equal(savesData({ connection: { saveData: true } }), true);
  assert.equal(savesData({ connection: { saveData: false } }), false);
  assert.equal(savesData({}), false);
});

test("a loader that fails is tried again once the connection is back", async () => {
  const target = eventTarget();
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1)
      throw new TypeError("Failed to fetch dynamically imported module");
  };
  const fine = async () => {};
  const failed = await preloadViews([fine, flaky], {
    schedule: now,
    saveData: false,
    target,
  });
  assert.deepEqual(failed, [flaky]);
  assert.equal(target.has("online"), true);
  target.fire("online");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(target.has("online"), false);
});
