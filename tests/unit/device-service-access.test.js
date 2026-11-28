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
