import test from "node:test";
import assert from "node:assert/strict";
import { fixture, owner } from "../helpers/device-service-fixture.js";
import { deferred } from "../helpers/memory-device-source.js";

// What the device service does when two things happen at once: a call during the
// reclaim at server start, a stop during a boot, calls beside an uninstall, a stop
// that failed. On the memory source, whose gates name the moment each test needs.
const refused = (code, extra = {}) => ({ code, status: 409, ...extra });
const removing = refused("DEVICE_UNAVAILABLE", { reason: "DEVICES_OPERATION_RUNNING" });

test("a start during the reclaim at server start waits for it and is not undone", async (t) => {
  const { service, source, create, state, settled } = fixture(t);
  const a = await create("A");
  const b = await create("B");
  const gate = deferred();
  const reclaim = source.reclaim;
  source.reclaim = async (records) => {
    await gate.promise;
    return reclaim(records);
  };
  const starting = service.start();
  // The routes are mounted already: a start, a stop and a create arrive.
  const booting = service.startDevice(a.id, { caller: owner });
  const stopping = service.stopDevice(b.id, { caller: owner });
  const creating = create("C");
  assert.equal(await settled(booting), false);
  assert.equal(await settled(stopping), false);
  assert.equal(await settled(creating), false);
  // Nothing touched the source before the leftovers are gone.
  assert.deepEqual(
    source.log.filter(([call]) => call !== "create"),
    [],
  );
  assert.equal(state(a.id), "stopped");
  gate.resolve();
  await Promise.all([starting, booting, stopping, creating]);
  assert.deepEqual(
    source.log.filter(([call]) => call !== "create").map(([call]) => call),
    ["reclaim", "start"],
  );
  // The device that booted meanwhile runs, holds its slot and can be stopped.
  assert.equal(state(a.id), "running");
  assert.equal(source.state({ id: a.id }).state, "running");
  assert.equal(service.view().counts.running, 1);
  await service.stopDevice(a.id, { caller: owner });
  assert.equal(source.state({ id: a.id }).state, "stopped");
  // A start() that finds a device in a slot leaves it there.
  await service.startDevice(a.id, { caller: owner });
  await service.start();
  assert.equal(state(a.id), "running");
  assert.equal(service.view().counts.running, 1);
  await service.shutdown({ graceMs: 1 });
});

test("stop, reset and delete end a boot in progress instead of waiting for it", async (t) => {
  const { service, source, clock, create, state, settled } = fixture(t);
  const a = await create("A");
  // A boot that never completes by itself.
  source.gates.start = () => new Promise(() => {});
  const cancelled = { code: "DEVICE_START_CANCELLED" };

  const first = service.startDevice(a.id, { caller: owner });
  assert.equal(await settled(first), false);
  assert.equal(state(a.id), "starting");
  assert.equal((await service.stopDevice(a.id, { caller: owner })).state, "stopped");
  await assert.rejects(first, cancelled);
  assert.equal(service.device(a.id).failure, null);
  assert.equal(service.view().counts.running, 0);
  assert.equal(source.state({ id: a.id }).state, "stopped");

  // A call that started the device is ended the same way.
  const call = service.adb(a.id, ["shell", "true"], { caller: owner });
  assert.equal(await settled(call), false);
  assert.equal(state(a.id), "starting");
  const reset = await service.reset(a.id, { caller: owner });
  await assert.rejects(call, cancelled);
  assert.equal(reset.state, "stopped");
  assert.deepEqual(source.calls("reset"), [a.id]);

  const third = service.startDevice(a.id, { caller: owner });
  assert.equal(await settled(third), false);
  await service.remove(a.id, { caller: owner });
  await assert.rejects(third, cancelled);
  assert.deepEqual(service.view().devices, []);
  assert.equal(service.view().counts.running, 0);

  // A start that still waits for a slot is ended before it boots.
  const b = await create("B");
  const c = await create("C");
  service.configure({ maxRunning: 1 });
  source.gates.start = null;
  await service.startDevice(b.id, { caller: owner });
  const stop = deferred();
  source.gates.stop = () => stop.promise;
  // B is idle long enough to make room; its stop is held, so C waits for the slot.
  await clock.advance(6 * 60000);
  const waiting = service.startDevice(c.id, { caller: owner });
  await settled(waiting);
  const starts = source.calls("start").length;
  const stopping = service.stopDevice(c.id, { caller: owner });
  stop.resolve();
  await stopping;
  await assert.rejects(waiting, cancelled);
  assert.equal(state(c.id), "stopped");
  assert.equal(state(b.id), "stopped");
  assert.equal(source.calls("start").length, starts);
});

test("nothing begins beside an uninstall, and an uninstall begins beside nothing", async (t) => {
  const { service, source, create, settled } = fixture(t);
  const a = await create("A");
  const b = await create("B");

  // A device with a reset under way, or with a call that waits: not now.
  const gate = deferred();
  source.gates.stop = () => gate.promise;
  await service.startDevice(a.id, { caller: owner });
  const resetting = service.reset(a.id, { caller: owner });
  assert.equal(await settled(resetting), false);
  await assert.rejects(service.removeAll(), refused("DEVICES_IN_USE"));
  gate.resolve();
  await resetting;
  source.gates.stop = null;
  const held = deferred();
  source.gates.exec = () => held.promise;
  source.gates.start = () => held.promise;
  const waiting = service.startDevice(b.id, { caller: owner });
  // Before the start has its slot it is a call that waits; then the device is in use.
  await assert.rejects(service.removeAll(), refused("DEVICE_BUSY"));
  assert.equal(await settled(waiting), false);
  await assert.rejects(service.removeAll(), refused("DEVICES_IN_USE"));
  held.resolve();
  await waiting;
  await service.stopDevice(b.id, { caller: owner });
  source.gates.start = null;
  source.gates.exec = null;
  // A reset that has not reached the source yet holds no slot, but it is an operation.
  const slow = deferred();
  const reset = source.reset;
  source.reset = async (record) => {
    await slow.promise;
    return reset(record);
  };
  const pending = service.reset(a.id, { caller: owner });
  assert.equal(await settled(pending), false);
  await assert.rejects(service.removeAll(), refused("DEVICE_BUSY"));
  slow.resolve();
  await pending;
  source.reset = reset;
  assert.equal(service.view().devices.length, 2);

  // While the removal runs, every new call is refused with a code, never a TypeError.
  const remove = source.remove;
  const removal = deferred();
  source.remove = async (record) => {
    await removal.promise;
    return remove(record);
  };
  const uninstalling = service.removeAll();
  for (const call of [
    () => service.startDevice(a.id, { caller: owner }),
    () => service.stopDevice(a.id, { caller: owner }),
    () => service.reset(a.id, { caller: owner }),
    () => service.remove(a.id, { caller: owner }),
    () => service.adb(a.id, ["shell", "true"], { caller: owner }),
    () => create("C"),
    () => service.removeAll(),
  ])
    await assert.rejects(async () => call(), removing);
  removal.resolve();
  await uninstalling;
  assert.deepEqual(service.view().devices, []);
  assert.deepEqual(service.store.list(), []);
  assert.deepEqual(source.calls("remove"), [a.id, b.id]);
  // Afterwards the service is open again (the SDK's removal refuses by itself).
  source.remove = remove;
  assert.equal((await create("D")).name, "D");
});

test("a create that waits when the uninstall begins is removed with the rest", async (t) => {
  const { service, source, create } = fixture(t);
  await create("A");
  const gate = deferred();
  const made = source.create;
  source.create = async (record) => {
    await gate.promise;
    return made(record);
  };
  const creating = create("B");
  const uninstalling = service.removeAll();
  gate.resolve();
  assert.equal((await creating).name, "B");
  await uninstalling;
  assert.deepEqual(service.store.list(), []);
  assert.equal(source.calls("remove").length, 2);
});

test("a device whose stop failed shows its process and can be stopped again", async (t) => {
  const { service, source, create, state } = fixture(t);
  const a = await create("A");
  assert.equal(service.device(a.id).live, false);
  await service.startDevice(a.id, { caller: owner });
  assert.equal(service.device(a.id).live, true);
  source.gates.stop = async () => {
    throw Object.assign(Error("DEVICE_STOP_FAILED"), {
      code: "DEVICE_STOP_FAILED",
      status: 409,
    });
  };
  await assert.rejects(
    service.stopDevice(a.id, { caller: owner }),
    refused("DEVICE_STOP_FAILED"),
  );
  assert.equal(state(a.id), "failed");
  assert.equal(service.device(a.id).failure.code, "DEVICE_STOP_FAILED");
  // The process is still there: the view says so and the device keeps its slot.
  assert.equal(service.device(a.id).live, true);
  assert.equal(service.view().counts.running, 1);
  source.gates.stop = null;
  const stopped = await service.stopDevice(a.id, { caller: owner });
  assert.deepEqual(
    { state: stopped.state, failure: stopped.failure, live: stopped.live },
    { state: "stopped", failure: null, live: false },
  );
  assert.equal(service.view().counts.running, 0);
});

test("a failure keeps the reason its refusal carried", async (t) => {
  const { service, source, create } = fixture(t);
  const a = await create("A");
  source.gates.start = async () => {
    throw Object.assign(Error("DEVICE_ADB_FAILED"), {
      code: "DEVICE_ADB_FAILED",
      status: 409,
      reason: "DEVICE_ADB_PORT_IN_USE",
    });
  };
  await assert.rejects(service.startDevice(a.id, { caller: owner }), {
    code: "DEVICE_ADB_FAILED",
  });
  assert.deepEqual(service.device(a.id).failure, {
    code: "DEVICE_ADB_FAILED",
    at: 0,
    reason: "DEVICE_ADB_PORT_IN_USE",
  });
  // Only a code is kept, nothing else an error may carry there.
  source.gates.start = async () => {
    throw Object.assign(Error("x"), { code: "DEVICE_EXITED", reason: "free text" });
  };
  await assert.rejects(service.startDevice(a.id, { caller: owner }));
  assert.deepEqual(service.device(a.id).failure, { code: "DEVICE_EXITED", at: 0 });
});
