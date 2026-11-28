import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  fakeAndroidSdk,
  freeDevicePorts,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import { AndroidSdk } from "../../server/features/devices/android-sdk.js";
import { DeviceService } from "../../server/features/devices/device-service.js";
import { EmulatorSource } from "../../server/features/devices/emulator-source.js";

// The device service on the emulator source, with the fake emulator and adb: the
// two layers as the application wires them, as real processes.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const owner = { kind: "owner" };

async function fixture(t) {
  const fake = await fakeAndroidSdk();
  const ports = await freeDevicePorts(2);
  await installFakeSdk(fake.dataDir, fake.manifest);
  const services = [];
  // One "process" of AgentPier on the fake's data folder.
  const application = () => {
    const sdk = new AndroidSdk({
      dataDir: fake.dataDir,
      manifest: fake.manifest,
      host: fake.host,
      problem: () => null,
      inUse: () => service.inUse(),
      imagesInUse: () => service.imagesInUse(),
    });
    const source = new EmulatorSource({
      dataDir: fake.dataDir,
      manifest: fake.manifest,
      host: fake.host,
      sdk,
      identity: fake.identity,
      pollMs: 20,
      killGraceMs: 2000,
      ...ports,
    });
    const service = new DeviceService({
      dataDir: fake.dataDir,
      sdk,
      sources: { emulator: source },
    });
    services.push(service);
    return { sdk, source, service };
  };
  t.after(async () => {
    for (const service of services) await service.shutdown({ graceMs: 1500 });
    const recorded = await fake.cleanup();
    assert.deepEqual(recorded.filter(alive), []);
    assert.equal(fs.existsSync(fake.root), false);
  });
  return { fake, ports, application };
}

test("a device lives through create, use, crash, restart and shutdown", async (t) => {
  const { fake, ports, application } = await fixture(t);
  const { service, sdk } = application();
  await service.start();
  const device = await service.create({
    name: "Pixel",
    creator: { kind: "owner", id: "owner", name: "Owner" },
  });
  assert.equal(device.image.id, fake.manifest.image.id);
  assert.ok(device.diskBytes > 0);
  assert.deepEqual(service.ports(), []);
  // The first call boots the device and runs its first-boot steps.
  const answer = await service.adb(device.id, ["shell", "echo", "hi"], { caller: owner });
  assert.equal(answer.stdout, "echo hi\n");
  assert.equal(service.device(device.id).state, "running");
  assert.equal(service.store.get(device.id).provisioned, true);
  assert.deepEqual(service.ports(), [
    ports.consolePorts.first,
    ports.consolePorts.first + 1,
  ]);
  assert.equal(sdk.inUse(), true);
  assert.throws(() => sdk.remove(), { code: "DEVICES_IN_USE" });
  // The emulator crashes: the device is failed and holds no slot.
  const [{ pid }] = fake.launches();
  process.kill(pid, "SIGKILL");
  await waitUntil(() => service.device(device.id).state === "failed", {
    describe: "the exit to be noticed",
  });
  assert.equal(service.device(device.id).failure.code, "DEVICE_EXITED");
  assert.equal(service.view().counts.running, 0);
  // It starts again, cold, because nothing was saved.
  await service.startDevice(device.id, { caller: owner });
  assert.ok(fake.launches()[1].argv.includes("-no-snapshot-load"));
  const left = fake.launches()[1].pid;

  // AgentPier ends without a shutdown; the next process reclaims the device.
  const next = application();
  await next.service.start();
  await waitUntil(() => !alive(left), { describe: "the leftover device to end" });
  assert.equal(next.service.device(device.id).state, "stopped");
  assert.equal(next.service.view().counts.total, 1);
  // The first process noticed the end of its child as well.
  await waitUntil(() => service.device(device.id).state === "failed", {
    describe: "the first process to notice",
  });
  await service.shutdown({ graceMs: 1500 });

  await next.service.startDevice(device.id, { caller: owner });
  const reset = await next.service.reset(device.id, { caller: owner });
  assert.equal(reset.state, "stopped");
  assert.equal(next.service.store.get(device.id).provisioned, false);
  await next.service.startDevice(device.id, { caller: owner });
  // A shutdown stops the device and the adb server within its bound.
  await next.service.shutdown({ graceMs: 3000 });
  assert.deepEqual(fake.emulators(), []);
  assert.deepEqual(fake.servers(), []);
  assert.deepEqual(fake.pids().filter(alive), []);
});
