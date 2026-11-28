import test from "node:test";
import assert from "node:assert/strict";
import { admit } from "../../server/features/devices/device-admission.js";

// Whether one more device may run, and which idle device makes room for it.
const minute = 60000;
const now = 100 * minute;
const limits = { now, busyMs: 5 * minute, idleCapMs: 60 * minute, wanted: "new" };
const device = (id, minutesUnused, extra = {}) => ({
  id,
  state: "running",
  lastUse: now - minutesUnused * minute,
  viewers: 0,
  held: false,
  queued: 0,
  ...extra,
});
const refused = { ok: false, code: "DEVICE_LIMIT_RUNNING" };

test("below the limit nothing is stopped", () => {
  assert.deepEqual(admit({ ...limits, running: [], limit: 1 }), {
    ok: true,
    evict: null,
  });
  assert.deepEqual(admit({ ...limits, running: [device("a", 30)], limit: 2 }), {
    ok: true,
    evict: null,
  });
});

test("at the limit an idle device makes room, the least recently used first", () => {
  assert.deepEqual(admit({ ...limits, running: [device("a", 30)], limit: 1 }), {
    ok: true,
    evict: "a",
  });
  const running = [device("a", 10), device("b", 40), device("c", 20)];
  assert.deepEqual(admit({ ...limits, running, limit: 3 }), { ok: true, evict: "b" });
  // Exactly `busyMs` ago counts as idle.
  assert.deepEqual(admit({ ...limits, running: [device("a", 5)], limit: 1 }), {
    ok: true,
    evict: "a",
  });
});

test("a device in use, viewed, held, queued or not running is never stopped", () => {
  for (const [name, busy] of Object.entries({
    used: device("a", 4),
    viewed: device("a", 30, { viewers: 1 }),
    held: device("a", 30, { held: true }),
    queued: device("a", 30, { queued: 1 }),
    starting: device("a", 30, { state: "starting" }),
    stopping: device("a", 30, { state: "stopping" }),
    failed: device("a", 30, { state: "failed" }),
  })) {
    assert.deepEqual(admit({ ...limits, running: [busy], limit: 1 }), refused, name);
    // Another idle device goes instead.
    assert.deepEqual(
      admit({ ...limits, running: [busy, device("b", 6)], limit: 2 }),
      { ok: true, evict: "b" },
      name,
    );
  }
  assert.deepEqual(
    admit({ ...limits, running: [device("a", 1), device("b", 2)], limit: 2 }),
    refused,
  );
});

test("a view keeps a device at most as long as it keeps it from the idle stop", () => {
  const viewed = (minutes) => [device("a", minutes, { viewers: 2 })];
  assert.deepEqual(admit({ ...limits, running: viewed(59), limit: 1 }), refused);
  assert.deepEqual(admit({ ...limits, running: viewed(60), limit: 1 }), {
    ok: true,
    evict: "a",
  });
  // The owner's hold has no such cap.
  assert.deepEqual(
    admit({ ...limits, running: [device("a", 600, { held: true })], limit: 1 }),
    refused,
  );
});

test("a device that already holds a slot needs no second one", () => {
  const running = [device("a", 1), device("new", 0, { state: "starting" })];
  assert.deepEqual(admit({ ...limits, running, limit: 2 }), { ok: true, evict: null });
  // The limit was lowered below what runs: one device goes per decision.
  assert.deepEqual(
    admit({ ...limits, running: [device("a", 30), device("b", 20)], limit: 1 }),
    { ok: true, evict: "a" },
  );
});
