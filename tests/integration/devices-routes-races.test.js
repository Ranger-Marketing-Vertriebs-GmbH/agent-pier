import test from "node:test";
import assert from "node:assert/strict";
import { devicesApp } from "../helpers/devices-app.js";
import { waitUntil } from "../helpers/fake-android-sdk.js";
import { deferred } from "../helpers/memory-device-source.js";

// The device routes when two requests meet: a stop during a boot, and calls beside
// the removal of the installation. On an application whose devices run on the fake
// SDK; every answer is a stable code, never the error handler's 500.
const post = (f, endpoint, body) => f.request(endpoint, { method: "POST", body });
const json = async (response) => ({
  status: response.status,
  body: await response.json(),
});
const refused = (code, status, extra = {}) => ({
  status,
  body: { code, error: code, ...extra },
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a stop, a reset and a delete during the boot do not wait for it", async (t) => {
  // A boot that never completes: only an abort ends it before the timeout.
  const { f, fake, devices } = await devicesApp(t, {
    options: { source: { bootTimeoutMs: 600000 } },
  });
  const device = await (await post(f, "/api/devices", { name: "Pixel" })).json();
  const at = `/api/devices/${device.id}`;
  fake.behaviour({ mode: "hang" });
  const booting = async (count) => {
    const start = await json(await post(f, `${at}/start`));
    assert.deepEqual([start.status, start.body.state], [202, "starting"]);
    await waitUntil(() => fake.launches().length === count, { describe: "the launch" });
    return fake.launches()[count - 1].pid;
  };
  const first = await booting(1);
  assert.equal((await post(f, `${at}/stop`)).status, 202);
  await waitUntil(() => devices.device(device.id).state === "stopped", {
    describe: "the device to stop",
  });
  assert.equal(devices.device(device.id).failure, null);
  await waitUntil(() => !alive(first), { describe: "the emulator to end" });
  assert.equal(devices.view().counts.running, 0);

  const second = await booting(2);
  const reset = await json(await post(f, `${at}/reset`));
  assert.deepEqual([reset.status, reset.body.state], [202, "stopped"]);
  assert.equal(alive(second), false);

  const third = await booting(3);
  assert.equal((await f.request(at, { method: "DELETE" })).status, 204);
  assert.equal(alive(third), false);
  assert.deepEqual(devices.view().devices, []);
});

test("requests beside the removal of the installation get a code, not an error", async (t) => {
  const { f, fake, devices, sdk } = await devicesApp(t, {
    options: { source: { bootTimeoutMs: 600000 } },
  });
  const device = await (await post(f, "/api/devices", { name: "Pixel" })).json();
  const at = `/api/devices/${device.id}`;
  // A device that boots keeps the installation.
  fake.behaviour({ mode: "hang" });
  assert.equal((await post(f, `${at}/start`)).status, 202);
  assert.deepEqual(
    await json(await post(f, "/api/devices/installation/remove")),
    refused("DEVICES_IN_USE", 409),
  );
  assert.equal(devices.view().counts.total, 1);
  assert.equal((await post(f, `${at}/stop`)).status, 202);
  await waitUntil(() => devices.device(device.id).state === "stopped", {
    describe: "the device to stop",
  });

  // The removal is held while it deletes the device.
  const source = devices.sources.emulator;
  const remove = source.remove.bind(source);
  const gate = deferred();
  source.remove = async (record) => {
    await gate.promise;
    return remove(record);
  };
  const removing = post(f, "/api/devices/installation/remove");
  await waitUntil(() => devices.removing, { describe: "the removal to begin" });
  const closed = refused("DEVICE_UNAVAILABLE", 409, {
    reason: "DEVICES_OPERATION_RUNNING",
  });
  assert.deepEqual(await json(await post(f, `${at}/start`)), closed);
  assert.deepEqual(await json(await post(f, `${at}/stop`)), closed);
  assert.deepEqual(await json(await post(f, `${at}/reset`)), closed);
  assert.deepEqual(await json(await f.request(at, { method: "DELETE" })), closed);
  assert.deepEqual(await json(await post(f, "/api/devices", { name: "Late" })), closed);
  assert.deepEqual(await json(await post(f, "/api/devices/installation/remove")), closed);
  gate.resolve();
  assert.equal((await removing).status, 202);
  await waitUntil(() => !sdk.operation, { describe: "the removal to end" });
  // Nothing of a device is left: no record, no folder, no process.
  assert.deepEqual(devices.view().devices, []);
  assert.deepEqual(devices.store.list(), []);
  assert.deepEqual(fake.emulators(), []);
});
