import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  fixtureImage as image,
  owner,
  session,
} from "../helpers/device-service-fixture.js";
import { deferred } from "../helpers/memory-device-source.js";
import { readDeviceSettings } from "../../server/features/devices/device-settings.js";

// The device service on a source that lives in memory, with a manual clock: limits,
// the per-device queue, the owner's hold, the idle stop, restart and shutdown.
const minute = 60000;
const never = () => new Promise(() => {});

test("a device is created within the limit of devices and shown in the view", async (t) => {
  const { service, source, sdk, signals, audited, create, dataDir } = fixture(t);
  const first = await create("One");
  assert.deepEqual(first, {
    id: first.id,
    name: "One",
    source: "emulator",
    state: "stopped",
    operation: null,
    failure: null,
    creator: { kind: "owner", id: "owner", name: "Owner", gone: false },
    assignments: [],
    image: { id: image, current: true },
    diskBytes: 1003,
    held: false,
    viewers: 0,
    createdAt: 0,
    lastUsedAt: null,
  });
  assert.deepEqual(source.log, [["create", first.id, image]]);
  assert.equal(signals.count, 1);
  assert.deepEqual(audited, [
    {
      action: "device.created",
      device: { id: first.id, name: "One" },
      caller: { kind: "owner", id: "owner" },
    },
  ]);
  for (const name of ["Two", "Three", "Four", "Five"]) await create(name);
  await assert.rejects(create("Six"), { code: "DEVICE_LIMIT_TOTAL", status: 409 });
  assert.deepEqual(service.view(), {
    availability: { available: true, reason: null },
    settings: { maxDevices: 5, maxRunning: 2 },
    counts: { total: 5, running: 0 },
    devices: service.view().devices,
  });
  assert.deepEqual(
    service.view().devices.map((device) => device.name),
    ["One", "Two", "Three", "Four", "Five"],
  );
  // The owner raises the limit; the setting is stored and validated.
  assert.deepEqual(service.configure({ maxDevices: 6 }), {
    maxDevices: 6,
    maxRunning: 2,
  });
  assert.equal(readDeviceSettings(dataDir).maxDevices, 6);
  assert.throws(() => service.configure({ maxRunning: 6 }), {
    code: "DEVICES_SETTINGS_INVALID",
    status: 400,
  });
  assert.equal((await create("Six")).name, "Six");
  service.configure({ maxDevices: 7 });
  await assert.rejects(create("six"), { code: "DEVICE_NAME_TAKEN" });
  // Without the SDK nothing is created; the view says why.
  sdk.reason = "DEVICES_NOT_INSTALLED";
  service.configure({ maxDevices: 20 });
  await assert.rejects(create("Seven"), {
    code: "DEVICE_UNAVAILABLE",
    reason: "DEVICES_NOT_INSTALLED",
    status: 409,
  });
  assert.deepEqual(service.view().availability, {
    available: false,
    reason: "DEVICES_NOT_INSTALLED",
  });
  // A device the source could not create leaves no record.
  sdk.reason = null;
  source.create = async () => {
    throw Object.assign(Error("DEVICE_DISK_SPACE"), { code: "DEVICE_DISK_SPACE" });
  };
  await assert.rejects(create("Seven"), { code: "DEVICE_DISK_SPACE" });
  assert.equal(service.view().counts.total, 6);
  assert.deepEqual(service.imagesInUse(), [image]);
});

test("two starts at a limit of one: one boots, the other is refused", async (t) => {
  const { service, source, signals, create, state, settled } = fixture(t);
  service.configure({ maxRunning: 1 });
  const a = await create("A");
  const b = await create("B");
  const gate = deferred();
  source.gates.start = () => gate.promise;
  const first = service.startDevice(a.id, { caller: owner });
  const second = service.startDevice(b.id, { caller: owner });
  await assert.rejects(second, { code: "DEVICE_LIMIT_RUNNING", status: 409 });
  // The slot was reserved before the boot was awaited.
  assert.equal(state(a.id), "starting");
  assert.equal(state(b.id), "stopped");
  assert.equal(await settled(first), false);
  gate.resolve();
  assert.equal((await first).state, "running");
  assert.deepEqual(source.calls("start"), [a.id]);
  assert.equal(source.peak.start, 1);
  assert.equal(source.peak.live, 1);
  assert.equal(signals.peak, 1);
  assert.equal(service.inUse(), true);
  // A second start of the running device is the same device.
  await service.startDevice(a.id, { caller: owner });
  assert.deepEqual(source.calls("start"), [a.id]);
});

test("two starts at a limit of two with one idle device: exactly one is stopped for them", async (t) => {
  const { service, source, clock, signals, create, state } = fixture(t);
  const [a, b, c] = [await create("A"), await create("B"), await create("C")];
  await service.startDevice(a.id, { caller: owner });
  await clock.advance(6 * minute);
  const gate = deferred();
  source.gates.start = () => gate.promise;
  source.gates.stop = async () => {
    // While the idle device stops, it still holds its slot.
    assert.equal(service.view().counts.running, 2);
  };
  const starts = [
    service.startDevice(b.id, { caller: owner }),
    service.startDevice(c.id, { caller: owner }),
  ];
  await clock.settle();
  assert.deepEqual(
    [state(a.id), state(b.id), state(c.id)],
    ["stopped", "starting", "starting"],
  );
  gate.resolve();
  await Promise.all(starts);
  assert.deepEqual(source.calls("stop"), [a.id]);
  assert.deepEqual(source.calls("start"), [a.id, b.id, c.id]);
  assert.equal(source.peak.live, 2);
  assert.equal(signals.peak, 2);
  assert.equal(service.view().counts.running, 2);
  // Both are in use now: a third start finds no device to stop.
  await assert.rejects(service.startDevice(a.id, { caller: owner }), {
    code: "DEVICE_LIMIT_RUNNING",
  });
  assert.equal(state(a.id), "stopped");
});

test("a viewed, held or recently used device is never stopped for another", async (t) => {
  const { service, source, clock, create, state } = fixture(t);
  service.configure({ maxRunning: 1 });
  const [a, b] = [await create("A"), await create("B")];
  const start = (id) => service.startDevice(id, { caller: owner });
  const refused = { code: "DEVICE_LIMIT_RUNNING" };
  await start(a.id);
  await assert.rejects(start(b.id), refused);
  await clock.advance(6 * minute);
  const unwatch = service.watch(a.id);
  assert.equal(service.device(a.id).viewers, 1);
  await assert.rejects(start(b.id), refused);
  unwatch();
  unwatch();
  assert.equal(service.device(a.id).viewers, 0);
  const hold = service.hold(a.id, { ms: 10 * minute });
  assert.equal(service.device(a.id).held, true);
  await assert.rejects(start(b.id), refused);
  hold.release();
  // A call that still waits on the device keeps it as well.
  const gate = deferred();
  source.gates.exec = () => gate.promise;
  const call = service.adb(a.id, ["shell", "true"], { caller: owner });
  await clock.settle();
  await assert.rejects(start(b.id), refused);
  gate.resolve();
  await call;
  await assert.rejects(start(b.id), refused);
  assert.deepEqual(source.calls("stop"), []);
  await clock.advance(5 * minute);
  assert.equal((await start(b.id)).state, "running");
  assert.equal(state(a.id), "stopped");
  // A device that cannot be stopped does not free its slot.
  await clock.advance(6 * minute);
  source.gates.stop = async () => {
    throw Object.assign(Error("DEVICE_STOP_FAILED"), { code: "DEVICE_STOP_FAILED" });
  };
  await assert.rejects(start(a.id), refused);
  assert.equal(state(b.id), "failed");
  assert.equal(service.device(b.id).failure.code, "DEVICE_STOP_FAILED");
  assert.equal(service.view().counts.running, 1);
});

test("calls on one device run one after another and start a stopped device", async (t) => {
  const { service, source, clock, create, state } = fixture(t);
  const device = await create("A");
  await assert.rejects(
    service.adb(device.id, ["shell", "true"], { caller: owner, start: false }),
    { code: "DEVICE_NOT_RUNNING", status: 409 },
  );
  assert.deepEqual(source.calls("start"), []);
  const running = [];
  source.gates.exec = async (record, args, options) => {
    running.push(`+${args[1]}`);
    assert.equal(options.caller, undefined);
    await clock.settle();
    running.push(`-${args[1]}`);
  };
  await clock.advance(1000);
  const calls = Array.from({ length: 10 }, (_, index) =>
    service.adb(device.id, ["shell", String(index)], { caller: owner, timeoutMs: 5 }),
  );
  const answers = await Promise.all(calls);
  assert.equal(source.peak.exec, 1);
  assert.deepEqual(
    running,
    Array.from({ length: 10 }, (_, index) => [`+${index}`, `-${index}`]).flat(),
  );
  assert.deepEqual(answers[3], {
    stdout: "shell 3\n",
    stderr: "",
    code: 0,
    truncated: false,
  });
  // The first call booted the device, once, and every call counts as use.
  assert.deepEqual(source.calls("start"), [device.id]);
  assert.equal(state(device.id), "running");
  assert.equal(service.device(device.id).lastUsedAt, 1000);
  // The first boot's steps ran: the record says so.
  assert.equal(service.store.get(device.id).provisioned, true);
  // A stop waits for the calls before it.
  const gate = deferred();
  source.gates.exec = () => gate.promise;
  const slow = service.adb(device.id, ["shell", "slow"], { caller: owner });
  const stop = service.stopDevice(device.id, { caller: owner });
  await clock.settle();
  assert.deepEqual(source.calls("stop"), []);
  gate.resolve();
  await slow;
  assert.equal((await stop).state, "stopped");
  assert.equal(service.store.get(device.id).lastUsedAt, 1000);
});

test("while the owner holds a device, other callers are refused", async (t) => {
  const { service, source, clock, signals, create } = fixture(t);
  const device = await create("A", { kind: "session", id: "s1", name: "Session" });
  const mine = session("s1");
  await service.adb(device.id, ["shell", "true"], { caller: mine });
  const before = signals.count;
  const hold = service.hold(device.id, { ms: 10 * minute });
  assert.equal(hold.until, 10 * minute);
  assert.equal(service.heldUntil(device.id), 10 * minute);
  assert.ok(signals.count > before);
  const held = { code: "DEVICE_HELD", status: 409 };
  await assert.rejects(service.adb(device.id, ["shell", "true"], { caller: mine }), held);
  await assert.rejects(service.stopDevice(device.id, { caller: mine }), held);
  await assert.rejects(service.reset(device.id, { caller: mine }), held);
  await assert.rejects(service.remove(device.id, { caller: mine }), held);
  // The owner works on.
  assert.equal(
    (await service.adb(device.id, ["shell", "tap"], { caller: owner })).code,
    0,
  );
  hold.release();
  assert.equal(service.heldUntil(device.id), null);
  assert.equal(
    (await service.adb(device.id, ["shell", "true"], { caller: mine })).code,
    0,
  );
  // A call that waited when the owner took the device is refused too.
  const gate = deferred();
  source.gates.exec = () => gate.promise;
  const first = service.adb(device.id, ["shell", "first"], { caller: mine });
  const waiting = service.adb(device.id, ["shell", "second"], { caller: mine });
  await clock.settle();
  const again = service.hold(device.id, { ms: minute });
  gate.resolve();
  await first;
  await assert.rejects(waiting, held);
  // A hold ends by itself, and can be extended before it does.
  await clock.advance(minute - 1);
  assert.equal(service.heldUntil(device.id), minute);
  again.extend(2 * minute);
  assert.equal(again.until, 3 * minute - 1);
  await clock.advance(2 * minute - 1);
  assert.equal(service.device(device.id).held, true);
  await clock.advance(1);
  assert.equal(service.device(device.id).held, false);
  assert.equal(service.heldUntil(device.id), null);
  // A new hold replaces an earlier one, whose handle does nothing any more.
  const old = service.hold(device.id, { ms: minute });
  service.hold(device.id, { ms: 5 * minute });
  old.release();
  await clock.advance(minute);
  assert.equal(service.device(device.id).held, true);
});

test("the idle stop takes a device after 15 minutes, a viewed one after 60", async (t) => {
  const { service, source, clock, create, state } = fixture(t);
  const [a, b] = [await create("A"), await create("B")];
  await service.start();
  await service.startDevice(a.id, { caller: owner });
  await service.startDevice(b.id, { caller: owner });
  const unwatch = service.watch(b.id);
  await clock.advance(14 * minute);
  assert.deepEqual([state(a.id), state(b.id)], ["running", "running"]);
  // A call counts as use: A's 15 minutes begin again.
  await service.adb(a.id, ["shell", "true"], { caller: owner });
  await clock.advance(14 * minute);
  assert.equal(state(a.id), "running");
  await clock.advance(minute);
  assert.deepEqual([state(a.id), state(b.id)], ["stopped", "running"]);
  assert.equal(service.device(a.id).diskBytes, 1001);
  await clock.advance(30 * minute);
  assert.equal(state(b.id), "running");
  // Viewed all the time, and still stopped an hour after its last use.
  await clock.advance(minute);
  assert.equal(state(b.id), "stopped");
  assert.deepEqual(source.calls("stop"), [a.id, b.id]);
  unwatch();
  // A device the owner holds is kept like a viewed one.
  await service.startDevice(a.id, { caller: owner });
  service.hold(a.id, { ms: 40 * minute });
  await clock.advance(39 * minute);
  assert.equal(state(a.id), "running");
  await clock.advance(2 * minute);
  assert.equal(state(a.id), "stopped");
  await service.shutdown({ graceMs: 10 });
});

test("after a restart the sources reclaim what was left and no device runs", async (t) => {
  const first = fixture(t);
  const a = await first.create("A");
  const b = await first.create("B", { kind: "agent", id: "a1", name: "Agent" });
  await first.service.startDevice(a.id, { caller: owner });
  assert.equal(first.service.view().counts.running, 1);
  // The process ends without a shutdown; another one starts on the same data.
  const second = fixture(t, { dataDir: first.dataDir });
  assert.equal(second.service.device(a.id).diskBytes, null);
  await second.service.start();
  assert.deepEqual(second.source.log, [["reclaim", [a.id, b.id]]]);
  assert.deepEqual(
    second.service.view().devices.map((device) => [device.name, device.state]),
    [
      ["A", "stopped"],
      ["B", "stopped"],
    ],
  );
  assert.equal(second.service.view().counts.running, 0);
  assert.equal(second.service.device(a.id).lastUsedAt, 0);
  assert.equal(second.service.device(b.id).diskBytes, 1001);
  assert.equal(second.signals.count, 1);
  // A reclaim that fails does not keep the service from starting.
  const third = fixture(t, { dataDir: first.dataDir });
  third.source.reclaim = async () => {
    throw Object.assign(Error("x"), { code: "EIO" });
  };
  t.mock.method(console, "warn", () => {});
  await third.service.start();
  assert.equal(third.service.view().counts.total, 2);
  for (const { service } of [second, third]) await service.shutdown({ graceMs: 1 });
});

test("shutdown returns within its bound although a device never stops", async (t) => {
  const { service, source, clock, create, settled } = fixture(t);
  const [a, b] = [await create("A"), await create("B")];
  await service.start();
  await service.startDevice(a.id, { caller: owner });
  await service.startDevice(b.id, { caller: owner });
  source.gates.stop = never;
  const closing = service.shutdown({ graceMs: 50 });
  await clock.advance(49);
  assert.equal(await settled(closing), false);
  await clock.advance(1);
  assert.equal(await settled(closing), true);
  // Both stops were issued at once, with less than the bound for the source.
  assert.deepEqual(source.log.slice(-3), [
    ["close", 33],
    ["stop", a.id],
    ["stop", b.id],
  ]);
  // No timer is left, and nothing starts or is created afterwards.
  assert.equal(clock.pending(), 0);
  const refused = { code: "DEVICE_UNAVAILABLE", reason: "DEVICES_SHUTTING_DOWN" };
  await assert.rejects(create("C"), refused);
  source.exit(a.id);
  await assert.rejects(service.startDevice(a.id, { caller: owner }), refused);
});

test("a device that ends by itself is failed, and one that cannot boot frees its slot", async (t) => {
  const { service, source, clock, signals, create, state } = fixture(t);
  service.configure({ maxRunning: 1 });
  const [a, b] = [await create("A"), await create("B")];
  await service.startDevice(a.id, { caller: owner });
  await clock.advance(7);
  const before = signals.count;
  source.exit(a.id, { code: 1, signal: null });
  assert.equal(signals.count, before + 1);
  assert.deepEqual(service.device(a.id).failure, { code: "DEVICE_EXITED", at: 7 });
  assert.equal(state(a.id), "failed");
  assert.equal(service.view().counts.running, 0);
  assert.equal(service.inUse(), false);
  // An exit of a device that does not run changes nothing.
  source.exit(b.id);
  assert.equal(state(b.id), "stopped");
  // The slot is free for another device, whose boot fails.
  source.gates.start = async () => {
    throw Object.assign(Error("DEVICE_BOOT_TIMEOUT"), { code: "DEVICE_BOOT_TIMEOUT" });
  };
  await assert.rejects(service.startDevice(b.id, { caller: owner }), {
    code: "DEVICE_BOOT_TIMEOUT",
  });
  assert.deepEqual(service.device(b.id).failure, { code: "DEVICE_BOOT_TIMEOUT", at: 7 });
  assert.equal(service.view().counts.running, 0);
  // A failure without a stable code is named generally and thrown as it is.
  source.gates.start = async () => {
    throw Object.assign(Error("/a/path"), { code: "EACCES" });
  };
  await assert.rejects(service.adb(b.id, ["shell", "x"], { caller: owner }), {
    code: "EACCES",
  });
  assert.equal(service.device(b.id).failure.code, "DEVICE_START_FAILED");
  // A start that was cancelled is no failure.
  source.gates.start = async () => {
    throw Object.assign(Error("x"), { code: "DEVICE_START_CANCELLED" });
  };
  await assert.rejects(service.startDevice(b.id, { caller: owner }));
  assert.deepEqual([state(b.id), service.device(b.id).failure], ["stopped", null]);
  // The failed device starts again, and a stop clears a failure too.
  source.gates.start = null;
  assert.equal((await service.startDevice(a.id, { caller: owner })).failure, null);
  source.exit(a.id);
  assert.equal((await service.stopDevice(a.id, { caller: owner })).state, "stopped");
  assert.equal(service.device(a.id).failure, null);
});

test("reset keeps id, name and assignments and moves the device to the pinned image", async (t) => {
  const { service, source, clock, sdk, audited, create, state } = fixture(t);
  const device = await create("A");
  const assigned = [{ kind: "session", id: "s1", name: "Session", manage: false }];
  service.registerAssignments("session", (id) => (id === device.id ? assigned : []));
  service.registerAssignments("agent", () => {
    throw Error("another feature's failure");
  });
  await service.startDevice(device.id, { caller: owner });
  assert.equal(service.store.get(device.id).provisioned, true);
  // A later release pins another image.
  sdk.manifest.image.id = source.image = "android-37-google_apis-r2";
  assert.deepEqual(service.device(device.id).image, { id: image, current: false });
  const gate = deferred();
  source.gates.stop = () => gate.promise;
  await clock.advance(50);
  const reset = service.reset(device.id, { caller: owner });
  // The operation shows at once, and nothing else works on the device meanwhile.
  assert.equal(service.device(device.id).operation, "reset");
  const busy = { code: "DEVICE_BUSY", status: 409 };
  await assert.rejects(service.adb(device.id, ["shell", "x"], { caller: owner }), busy);
  await assert.rejects(service.startDevice(device.id, { caller: owner }), busy);
  await assert.rejects(service.stopDevice(device.id, { caller: owner }), busy);
  await assert.rejects(service.reset(device.id, { caller: owner }), busy);
  await assert.rejects(service.remove(device.id, { caller: owner }), busy);
  gate.resolve();
  const after = await reset;
  assert.deepEqual(
    { ...after, diskBytes: null },
    {
      ...device,
      assignments: assigned,
      image: { id: "android-37-google_apis-r2", current: true },
      diskBytes: null,
      lastUsedAt: 0,
    },
  );
  assert.equal(state(device.id), "stopped");
  assert.deepEqual(
    source.log.slice(-2).map(([name]) => name),
    ["stop", "reset"],
  );
  const stored = service.store.get(device.id);
  assert.deepEqual(
    [stored.image, stored.provisioned, stored.resetAt],
    ["android-37-google_apis-r2", false, 50],
  );
  assert.deepEqual(audited.at(-1), {
    action: "device.reset",
    device: { id: device.id, name: "A" },
    caller: { kind: "owner" },
  });
  // A reset the source refuses leaves the device as it was.
  await service.startDevice(device.id, { caller: owner });
  source.reset = async () => {
    throw Object.assign(Error("x"), { code: "DEVICE_IMAGE_MISSING" });
  };
  await assert.rejects(service.reset(device.id, { caller: owner }), {
    code: "DEVICE_IMAGE_MISSING",
  });
  assert.deepEqual(
    [state(device.id), service.device(device.id).operation],
    ["running", null],
  );
});
