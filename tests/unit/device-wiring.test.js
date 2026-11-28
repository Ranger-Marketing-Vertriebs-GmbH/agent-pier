import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeDeviceOptions } from "../helpers/devices-app.js";
import {
  fakeAndroidSdk,
  freeDevicePorts,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import {
  connectDevices,
  shutdownDevices,
  startDevices,
} from "../../server/application/device-wiring.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

// The wiring of Android devices without the rest of the application: `services` as
// app.js hands it over, the fake SDK, and the hooks run by hand.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const owner = { kind: "owner" };

// One "process" of AgentPier: its services, mounted routers and start hooks.
function process_(dataDir, androidDevices) {
  const services = {
    config: { dataDir, androidDevices },
    audit: { rows: [], append: (row) => services.audit.rows.push(auditEvent(row)) },
    live: { signals: [], invalidate: (name) => services.live.signals.push(name) },
  };
  const mounted = [];
  const whenListening = [];
  connectDevices(services, { mount: (router) => mounted.push(router), whenListening });
  const listen = () => Promise.all(whenListening.map((start) => start()));
  return { services, mounted, whenListening, listen };
}

async function fixture(t) {
  const fake = await fakeAndroidSdk();
  const ports = await freeDevicePorts(2);
  await installFakeSdk(fake.dataDir, fake.manifest);
  const started = [];
  const start = () => {
    const next = process_(fake.dataDir, fakeDeviceOptions(fake, ports));
    started.push(next);
    return next;
  };
  t.after(async () => {
    for (const { services } of started) await shutdownDevices(services);
    const recorded = await fake.cleanup();
    assert.deepEqual(recorded.filter(alive), []);
  });
  return { fake, ports, start };
}

test("connecting sets the services, mounts the routes and starts nothing", async (t) => {
  const { fake, start } = await fixture(t);
  const { services, mounted, whenListening, listen } = start();
  assert.equal(typeof services.devices.view, "function");
  assert.equal(typeof services.androidSdk.status, "function");
  assert.equal(typeof services.sessionDeviceGrants.grantsOf, "function");
  assert.equal(typeof services.agentDeviceGrants.grantsOf, "function");
  assert.equal(typeof services.deviceActions.run, "function");
  // The devices' routes and the sessions' and the agents' device routes.
  assert.equal(mounted.length, 3);
  assert.equal(whenListening.length, 1);
  await listen();
  assert.deepEqual(services.devices.view().availability, {
    available: true,
    reason: null,
  });
  assert.equal(services.androidSdk.status().state, "installed");
  assert.deepEqual([fake.launches(), fake.calls(), fake.servers()], [[], [], []]);
  // The start told the browser once what there is.
  assert.ok(services.live.signals.includes("devices"));
});

test("closing stops a running device and its adb server and leaves no process", async (t) => {
  const { fake, start } = await fixture(t);
  const { services, listen } = start();
  await listen();
  const device = await services.devices.create({
    name: "Pixel",
    creator: { kind: "owner", id: "owner", name: "" },
  });
  services.live.signals.length = 0;
  await services.devices.startDevice(device.id, { caller: owner });
  assert.ok(services.live.signals.includes("devices"));
  assert.equal(fake.emulators().length, 1);
  assert.equal(fake.servers().length, 1);
  const pids = fake.pids().filter(alive);
  assert.ok(pids.length >= 2);
  await shutdownDevices(services);
  assert.deepEqual(pids.filter(alive), []);
  assert.deepEqual([fake.emulators(), fake.servers()], [[], []]);
  // Nothing starts after the shutdown, and a second one is harmless.
  await assert.rejects(
    services.devices.create({ name: "Late", creator: { kind: "owner" } }),
    { code: "DEVICE_UNAVAILABLE", reason: "DEVICES_SHUTTING_DOWN" },
  );
  await shutdownDevices(services);
  await shutdownDevices({});
});

test("a start with leftover run records reclaims the processes", async (t) => {
  const { fake, start } = await fixture(t);
  const first = start();
  await first.listen();
  const device = await first.services.devices.create({
    name: "Pixel",
    creator: { kind: "owner", id: "owner", name: "" },
  });
  await first.services.devices.startDevice(device.id, { caller: owner });
  const [{ pid }] = fake.emulators();
  const [server] = fake.servers();
  assert.ok(fs.existsSync(path.join(fake.paths.run, `${device.id}.json`)));
  // That process "ends" without a shutdown; the next one finds what it left.
  const next = start();
  await next.listen();
  await waitUntil(() => !alive(pid) && !alive(server.pid), {
    describe: "the leftover processes to end",
  });
  assert.equal(fs.existsSync(path.join(fake.paths.run, `${device.id}.json`)), false);
  assert.equal(next.services.devices.device(device.id).state, "stopped");
  assert.equal(next.services.devices.view().counts.running, 0);
  // The device starts again in the new process.
  await next.services.devices.startDevice(device.id, { caller: owner });
  assert.equal(next.services.devices.device(device.id).state, "running");
  await waitUntil(() => first.services.devices.device(device.id).state === "failed", {
    describe: "the first process to notice",
  });
});

test("a pending request of the installer installs at the start, recorded as the system's", async (t) => {
  const fake = await fakeAndroidSdk();
  t.after(async () => {
    const recorded = await fake.cleanup();
    assert.deepEqual(recorded.filter(alive), []);
  });
  const ports = await freeDevicePorts(1);
  const { services, listen } = process_(fake.dataDir, fakeDeviceOptions(fake, ports));
  t.after(() => shutdownDevices(services));
  services.androidSdk.save({
    requested: true,
    terms: { acceptedAt: 1, by: "installer", versions: {} },
  });
  await listen();
  assert.notEqual(services.androidSdk.operation, null);
  await waitUntil(() => !services.androidSdk.operation, {
    describe: "the installation to end",
  });
  assert.equal(services.androidSdk.status().state, "installed");
  assert.ok(services.live.signals.includes("devices.installation"));
  assert.deepEqual(
    services.audit.rows.map((row) => [
      row.action,
      row.resourceId,
      row.source,
      row.outcome,
    ]),
    [["tool.installed", "android-devices", "system", "success"]],
  );
});

test("an interrupted installation and a shutdown leave no audit row and no failure of the start", async (t) => {
  const fake = await fakeAndroidSdk();
  t.after(async () => void (await fake.cleanup()));
  const ports = await freeDevicePorts(1);
  const first = process_(fake.dataDir, fakeDeviceOptions(fake, ports));
  await first.listen();
  fake.fetchImpl.stall("emulator");
  first.services.androidSdk.install({ acceptTerms: true });
  await waitUntil(
    () => first.services.androidSdk.status().progress?.component === "emulator",
    { describe: "the emulator download" },
  );
  await shutdownDevices(first.services);
  assert.equal(first.services.androidSdk.operation, null);
  assert.deepEqual(first.services.audit.rows, []);
  assert.equal(first.services.androidSdk.settings().requested, true);
  // The next process continues it.
  fake.fetchImpl.reset();
  const next = process_(fake.dataDir, fakeDeviceOptions(fake, ports));
  t.after(() => shutdownDevices(next.services));
  await next.listen();
  await waitUntil(() => !next.services.androidSdk.operation, {
    describe: "the installation to end",
  });
  assert.equal(next.services.androidSdk.status().state, "installed");
  assert.deepEqual(
    next.services.audit.rows.map((row) => [row.action, row.source]),
    [["tool.installed", "user"]],
  );
});

test("without an installation the start reads, starts no process and never throws", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "device-wiring-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const spawn = (...args) => {
    spawned.push(args);
    throw Error("nothing may be started");
  };
  // The real manifest on this host, then on one without an emulator build.
  for (const host of [undefined, { platform: "linux", arch: "arm64" }]) {
    const { services, listen } = process_(dataDir, {
      ...(host && { host }),
      source: { spawn },
    });
    await listen();
    const { available, reason } = services.devices.view().availability;
    assert.equal(available, false);
    assert.match(reason, /^DEVICES_(?:NOT_INSTALLED|PLATFORM_UNSUPPORTED|KVM_[A-Z]+)$/);
    assert.equal(services.androidSdk.operation, null);
    await shutdownDevices(services);
  }
  assert.deepEqual(spawned, []);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  // A failing step is logged, not thrown.
  const errors = t.mock.method(console, "error", () => {});
  await startDevices({
    androidSdk: {
      recover() {
        throw Object.assign(Error("no"), { code: "EACCES" });
      },
      resume() {
        throw Error("no");
      },
    },
    devices: { start: () => Promise.reject(Error("no")) },
  });
  assert.equal(errors.mock.callCount(), 3);
  assert.match(errors.mock.calls[0].arguments[0], /EACCES/);
});

test("device audit rows name the caller's kind and never the device's name", async (t) => {
  const { start } = await fixture(t);
  const { services, listen } = start();
  await listen();
  const creator = { kind: "session", id: "s1", name: "Shop" };
  const device = await services.devices.create({ name: "Secret phone", creator });
  await services.devices.reset(device.id, { caller: { kind: "session", id: "s1" } });
  await services.devices.remove(device.id, { caller: owner });
  assert.deepEqual(
    services.audit.rows.map((row) => [
      row.action,
      row.resourceType,
      row.resourceId,
      row.source,
      row.sessionId,
      row.details,
    ]),
    [
      ["device.created", "device", device.id, "mcp", "s1", { caller: "session" }],
      ["device.reset", "device", device.id, "mcp", "s1", { caller: "session" }],
      ["device.deleted", "device", device.id, "user", undefined, { caller: "owner" }],
    ],
  );
  assert.equal(JSON.stringify(services.audit.rows).includes("Secret"), false);
  // A store that refuses a row does not fail the change.
  const errors = t.mock.method(console, "error", () => {});
  services.audit.append = () => {
    throw Object.assign(Error("full"), { code: "SQLITE_FULL" });
  };
  const other = await services.devices.create({ name: "Other", creator });
  assert.equal(other.name, "Other");
  assert.match(errors.mock.calls[0].arguments[0], /SQLITE_FULL/);
});
