import test from "node:test";
import assert from "node:assert/strict";
import { agent, fixture, owner, session } from "../helpers/device-service-fixture.js";
import { deferred } from "../helpers/memory-device-source.js";

// Who may use and manage a device, and what a removal does (device-service.js).
const minute = 60000;

test("a creator manages its own devices; anyone else needs a grant", async (t) => {
  const { service, create } = fixture(t);
  const mine = await create("Mine", { kind: "session", id: "s1", name: "Session one" });
  const shared = await create("Shared");
  const managed = await create("Managed");
  await create("Agent's", { kind: "agent", id: "s1", name: "Agent" });
  service.registerGrants("session", (id) =>
    id === "s1"
      ? [
          { deviceId: shared.id, manage: false },
          { deviceId: managed.id, manage: true },
          { deviceId: "d-000000000000", manage: true },
        ]
      : [],
  );
  service.registerGrants("session", () => {
    throw Error("another feature's failure");
  });
  service.registerGrants("agent", (id) =>
    id === "a2" ? [{ deviceId: shared.id, manage: true }] : [],
  );
  assert.throws(() => service.registerGrants("owner", () => []), TypeError);
  const listed = (caller) =>
    service.devicesFor(caller).map((device) => [device.name, device.manage]);
  assert.deepEqual(listed(session("s1")), [
    ["Mine", true],
    ["Shared", false],
    ["Managed", true],
  ]);
  assert.equal(service.devicesFor(session("s1"))[0].state, "stopped");
  assert.deepEqual(listed(session("s2")), []);
  // The same id of another kind is another caller.
  assert.deepEqual(listed(agent("s1")), [["Agent's", true]]);
  assert.deepEqual(listed(agent("a2")), [["Shared", true]]);
  assert.equal(listed(owner).length, 4);
  assert.deepEqual(listed({ kind: "session" }), []);
  assert.deepEqual(listed(undefined), []);
  assert.deepEqual(service.permission(session("s1"), shared.id), {
    use: true,
    manage: false,
  });
  assert.deepEqual(service.permission(session("s2"), mine.id), {
    use: false,
    manage: false,
  });
  assert.throws(() => service.permission(owner, "d-000000000000"), {
    code: "DEVICE_NOT_FOUND",
    status: 404,
  });
  const forbidden = { code: "DEVICE_FORBIDDEN", status: 403 };
  // Use without manage: the device works, reset and delete are refused.
  assert.equal(
    (await service.adb(shared.id, ["shell", "x"], { caller: session("s1") })).code,
    0,
  );
  await assert.rejects(service.reset(shared.id, { caller: session("s1") }), forbidden);
  await assert.rejects(service.remove(shared.id, { caller: session("s1") }), forbidden);
  await service.stopDevice(shared.id, { caller: session("s1") });
  // No grant, no caller: nothing.
  for (const caller of [
    session("s2"),
    agent("s1"),
    { kind: "robot", id: "s1" },
    undefined,
  ]) {
    await assert.rejects(service.adb(mine.id, ["shell", "x"], { caller }), forbidden);
    await assert.rejects(service.startDevice(mine.id, { caller }), forbidden);
    await assert.rejects(service.stopDevice(mine.id, { caller }), forbidden);
    await assert.rejects(service.remove(mine.id, { caller }), forbidden);
  }
  await service.reset(managed.id, { caller: session("s1") });
  await service.reset(mine.id, { caller: session("s1") });
  await assert.rejects(service.adb("d-000000000000", ["x"], { caller: owner }), {
    code: "DEVICE_NOT_FOUND",
  });
  // A creator that no longer exists is shown as gone; the device stays.
  const gone = fixture(t, {
    dataDir: service.dataDir,
    creatorExists: (creator) => creator.kind !== "session",
  });
  assert.deepEqual(
    gone.service.view().devices.map((device) => device.creator.gone),
    [true, false, false, false],
  );
});

test("a grant taken away while a call waited is no grant at its turn", async (t) => {
  const { service, source, create, clock } = fixture(t);
  const device = await create("Shared");
  let grants = [{ deviceId: device.id, manage: true }];
  service.registerGrants("session", (id) => (id === "s1" ? grants : []));
  const caller = session("s1");
  const forbidden = { code: "DEVICE_FORBIDDEN", status: 403 };
  await service.startDevice(device.id, { caller });
  // A long shell command of the session's runs; more of its calls wait behind it.
  const gate = deferred();
  source.gates.exec = () => gate.promise;
  const running = service.adb(device.id, ["shell", "sleep 100"], { caller });
  const waiting = [
    service.adb(device.id, ["shell", "id"], { caller }),
    service.startDevice(device.id, { caller }),
    service.stopDevice(device.id, { caller }),
    service.reset(device.id, { caller }),
  ];
  for (const call of waiting) call.catch(() => {});
  await clock.settle();
  // The owner takes the device away from the session.
  grants = [];
  source.gates.exec = null;
  gate.resolve();
  assert.equal((await running).code, 0);
  for (const call of waiting) await assert.rejects(call, forbidden);
  assert.deepEqual(
    source.log.filter(([name]) => name !== "create").map(([name]) => name),
    ["start", "exec"],
  );
  assert.equal(service.device(device.id).state, "running");
  assert.equal(service.device(device.id).operation, null);
  // Reset and delete need `manage` at their turn too, not only `use`.
  grants = [{ deviceId: device.id, manage: true }];
  const again = deferred();
  source.gates.exec = () => again.promise;
  const busy = service.adb(device.id, ["shell", "sleep 100"], { caller });
  const removal = service.remove(device.id, { caller });
  removal.catch(() => {});
  await clock.settle();
  grants = [{ deviceId: device.id, manage: false }];
  source.gates.exec = null;
  again.resolve();
  await busy;
  await assert.rejects(removal, forbidden);
  assert.equal(service.device(device.id).state, "running");
  // The owner's own calls are never refused this way.
  assert.equal((await service.adb(device.id, ["shell", "x"], { caller: owner })).code, 0);
});

test("remove deletes the device, tells the listeners and frees the name", async (t) => {
  const { service, source, audited, create } = fixture(t);
  const device = await create("A");
  const kept = await create("B");
  const removed = [];
  const off = service.onRemoved((id) => removed.push(id));
  service.onRemoved(() => {
    throw Error("another feature's failure");
  });
  t.mock.method(console, "error", () => {});
  // Every change of the view is heard, until the listener is taken away; a failing
  // listener stops neither the others nor the change.
  let changes = 0;
  service.onChanged(() => {
    throw Error("another feature's failure");
  });
  const unheard = service.onChanged(() => changes++);
  await service.startDevice(device.id, { caller: owner });
  assert.ok(changes >= 2);
  unheard();
  const heard = changes;
  service.hold(device.id, { ms: minute });
  const gate = deferred();
  source.gates.stop = () => gate.promise;
  const removal = service.remove(device.id, { caller: owner });
  assert.equal(service.device(device.id).operation, "delete");
  gate.resolve();
  assert.equal(await removal, undefined);
  assert.deepEqual(removed, [device.id]);
  assert.equal(changes, heard);
  assert.deepEqual(
    service.view().devices.map((entry) => entry.id),
    [kept.id],
  );
  assert.throws(() => service.device(device.id), { code: "DEVICE_NOT_FOUND" });
  assert.deepEqual(
    source.log.slice(-2).map(([name]) => name),
    ["stop", "remove"],
  );
  assert.equal(audited.at(-1).action, "device.deleted");
  assert.equal((await create("A")).name, "A");
  // Removing the SDK removes every device, but only while none runs.
  off();
  await service.startDevice(kept.id, { caller: owner });
  await assert.rejects(service.removeAll(), { code: "DEVICES_IN_USE", status: 409 });
  assert.equal(service.view().counts.total, 2);
  await service.stopDevice(kept.id, { caller: owner });
  await service.removeAll();
  assert.deepEqual(service.view().devices, []);
  assert.deepEqual(removed, [device.id]);
  assert.equal(source.calls("remove").length, 3);
});
