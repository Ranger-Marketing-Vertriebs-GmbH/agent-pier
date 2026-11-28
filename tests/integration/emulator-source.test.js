import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  fakeAndroidSdk,
  freeDevicePorts,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import { AndroidSdk } from "../../server/features/devices/android-sdk.js";
import { hasSnapshot } from "../../server/features/devices/avd-files.js";
import { assertSource } from "../../server/features/devices/device-source.js";
import { EmulatorSource } from "../../server/features/devices/emulator-source.js";
import { processIdentity } from "../../server/lib/process-identity.js";

// The emulator source against the fake emulator and the fake adb: real child
// processes, real loopback ports of the test's own, nothing of Google's. Every test
// ends with no process and no folder left.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = (pid) => waitUntil(() => !alive(pid), { describe: `pid ${pid} to end` });
const device = (id = "d-0123456789ab", extra = {}) => ({
  id,
  provisioned: true,
  ...extra,
});

async function fixture(t, { pairs = 2, install = true, ...options } = {}) {
  const sdk = await fakeAndroidSdk();
  const ports = await freeDevicePorts(pairs);
  if (install) await installFakeSdk(sdk.dataDir, sdk.manifest);
  const sources = [];
  const listeners = [];
  const children = [];
  // `manifest` is another pin of the same fake SDK where a test needs one.
  const source = (overrides = {}) => {
    const manifest = overrides.manifest || sdk.manifest;
    const made = new EmulatorSource({
      dataDir: sdk.dataDir,
      manifest,
      host: sdk.host,
      sdk: new AndroidSdk({
        dataDir: sdk.dataDir,
        manifest: overrides.installed || manifest,
        host: sdk.host,
        problem: () => null,
      }),
      identity: sdk.identity,
      pollMs: 20,
      stopGraceMs: 5000,
      killGraceMs: 2000,
      ...ports,
      ...options,
      ...overrides,
    });
    sources.push(made);
    return made;
  };
  t.after(async () => {
    for (const made of sources) await made.close({ graceMs: 1000 });
    for (const listener of listeners)
      if (listener.listening) await new Promise((done) => listener.close(done));
    for (const child of children) {
      child.kill("SIGKILL");
      await child.done;
    }
    const recorded = await sdk.cleanup();
    assert.deepEqual(recorded.filter(alive), []);
    assert.equal(fs.existsSync(sdk.root), false);
  });
  // A listener that accepts a connection and never answers.
  const occupy = (port) =>
    new Promise((resolve) => {
      const listener = net.createServer((socket) => {
        socket.on("error", () => {});
        socket.resume();
      });
      listeners.push(listener);
      listener.listen(port, "127.0.0.1", () => resolve(listener));
    });
  const track = (child) => {
    child.done = new Promise((resolve) => child.once("close", resolve));
    children.push(child);
    return child;
  };
  const record = device(undefined, { image: sdk.manifest.image.id });
  return { sdk, ports, source, occupy, track, record, paths: sdk.paths };
}
const flag = (launch, name) => launch.argv.includes(name);
const runFiles = (paths) =>
  fs.readdirSync(paths.run).filter((name) => /^d-.*\.json$/.test(name));

test("a start boots the device in AgentPier's own environment", async (t) => {
  const inherited = { ANDROID_SDK_ROOT: "/elsewhere/sdk", ANDROID_SERIAL: "theirs" };
  const before = Object.fromEntries(
    Object.keys(inherited).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, inherited);
  t.after(() => {
    for (const [name, value] of Object.entries(before))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const { sdk, ports, source, record, paths } = await fixture(t);
  const emulator = assertSource(source());
  assert.equal(emulator.availability(), null);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
  await emulator.create(record);
  assert.equal(sdk.launches().length, 0);
  const serial = `emulator-${ports.consolePorts.first}`;
  assert.deepEqual(await emulator.start(record), { serial });
  assert.deepEqual(emulator.state(record), { state: "running", serial });
  assert.deepEqual(emulator.ports(record), [
    ports.consolePorts.first,
    ports.consolePorts.first + 1,
  ]);
  const [launch] = sdk.launches();
  assert.equal(launch.avd, record.id);
  assert.deepEqual(launch.argv, [
    "-avd",
    record.id,
    "-ports",
    `${ports.consolePorts.first},${ports.consolePorts.first + 1}`,
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-gpu",
    "swiftshader_indirect",
    "-cores",
    "4",
    "-memory",
    "2048",
    "-no-metrics",
  ]);
  assert.equal(flag(launch, "-grpc"), false);
  assert.equal(launch.env.HOME, paths.home);
  assert.ok(paths.home.startsWith(sdk.dataDir));
  assert.equal(launch.env.ANDROID_SDK_ROOT, paths.sdk);
  assert.equal(launch.env.ANDROID_AVD_HOME, paths.avd);
  assert.equal(launch.env.ANDROID_ADB_SERVER_PORT, String(ports.adbPort));
  assert.equal(launch.env.TMPDIR, paths.tmp);
  assert.equal("ANDROID_SERIAL" in launch.env, false);
  // Emulator and adb started with umask 077: what they create is the owner's only.
  assert.equal(launch.umask, 0o077);
  const folder = path.join(paths.avd, `${record.id}.avd`);
  for (const name of fs.readdirSync(folder))
    assert.equal(fs.statSync(path.join(folder, name)).mode & 0o077, 0, name);
  for (const call of sdk.calls()) {
    assert.equal(call.env.ANDROID_ADB_SERVER_PORT, String(ports.adbPort));
    assert.equal(call.env.ADB_MDNS, "0");
    assert.equal(call.umask, 0o077);
  }
  // The run record names the process; the log is the owner's.
  const stored = JSON.parse(
    fs.readFileSync(path.join(paths.run, `${record.id}.json`), "utf8"),
  );
  assert.deepEqual(stored, {
    pid: launch.pid,
    startTime: processIdentity(launch.pid).startTime,
    consolePort: ports.consolePorts.first,
    adbPort: ports.consolePorts.first + 1,
  });
  assert.equal(
    fs.statSync(path.join(paths.logs, `${record.id}.log`)).mode & 0o777,
    0o600,
  );
  // A second start of a running device is the same device.
  assert.deepEqual(await emulator.start(record), { serial });
  assert.equal(sdk.launches().length, 1);
  const answer = await emulator.exec(record, ["shell", "echo", "hello"]);
  assert.deepEqual(
    { stdout: answer.stdout, code: answer.code },
    { stdout: "echo hello\n", code: 0 },
  );
  assert.ok((await emulator.diskBytes(record)) > 0);
  await emulator.stop(record);
  await gone(launch.pid);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
  assert.deepEqual(emulator.ports(record), []);
  assert.deepEqual(runFiles(paths), []);
  await assert.rejects(emulator.exec(record, ["shell", "true"]), {
    code: "DEVICE_NOT_RUNNING",
  });
  // The adb server leaves with the last device.
  await waitUntil(() => sdk.servers().length === 0, { describe: "the adb server's end" });
});

test("a stop saves the snapshot; only an unclean end forces a cold boot", async (t) => {
  const { sdk, source, record, paths } = await fixture(t);
  const emulator = source();
  const exits = [];
  emulator.onExit = (id, result) => exits.push({ id, ...result });
  await emulator.create(record);
  await emulator.start(record);
  assert.equal(hasSnapshot(paths, record.id), false);
  await emulator.stop(record);
  assert.equal(hasSnapshot(paths, record.id), true);
  await emulator.start(record);
  assert.equal(flag(sdk.launches()[1], "-no-snapshot-load"), false);
  assert.equal(sdk.emulators()[0].snapshotLoaded, true);
  // An answered stop is not an exit the source reports.
  await emulator.stop(record);
  assert.deepEqual(exits, []);
  // The device ends by itself while it runs: reported, and the next start is cold.
  sdk.behaviour({ mode: "crash", crashMs: 20 });
  const ended = new Promise((resolve) => {
    emulator.onExit = (id, result) => resolve({ id, ...result });
  });
  await emulator.start(record);
  assert.equal(flag(sdk.launches()[2], "-no-snapshot-load"), false);
  assert.deepEqual(await ended, { id: record.id, code: 1, signal: null });
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
  assert.deepEqual(runFiles(paths), []);
  sdk.behaviour({ mode: "boot" });
  emulator.onExit = null;
  await emulator.start(record);
  assert.equal(flag(sdk.launches()[3], "-no-snapshot-load"), true);
  assert.equal(sdk.emulators()[0].snapshotLoaded, false);
  // After that clean stop the snapshot is current again.
  await emulator.stop(record);
  await emulator.start(record);
  assert.equal(flag(sdk.launches()[4], "-no-snapshot-load"), false);
});

test("a device that dies during the boot fails the start at once", async (t) => {
  const { sdk, source, record, paths } = await fixture(t, { bootTimeoutMs: 600000 });
  const emulator = source();
  await emulator.create(record);
  sdk.behaviour({ mode: "die" });
  await assert.rejects(emulator.start(record), {
    code: "DEVICE_EXITED",
    exitCode: 1,
    status: 409,
  });
  assert.deepEqual(runFiles(paths), []);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
  await gone(sdk.launches()[0].pid);
  assert.match(
    fs.readFileSync(path.join(paths.logs, `${record.id}.log`), "utf8"),
    /died before the boot/,
  );
  // Its ports are free again: the next start takes the first pair.
  sdk.behaviour({ mode: "boot" });
  assert.match((await emulator.start(record)).serial, /^emulator-\d+$/);
  assert.equal(sdk.launches()[1].argv[3], sdk.launches()[0].argv[3]);
});

test("a boot that never completes ends at the timeout with the process killed", async (t) => {
  // The pid as the source got it: a loaded machine may reach the timeout before the
  // fake has recorded its launch.
  const pids = [];
  const { sdk, source, record, paths } = await fixture(t, {
    bootTimeoutMs: 300,
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      if (args.includes(paths.emulatorBin)) pids.push(child.pid);
      return child;
    },
  });
  const emulator = source();
  await emulator.create(record);
  sdk.behaviour({ mode: "hang" });
  await assert.rejects(emulator.start(record), { code: "DEVICE_BOOT_TIMEOUT" });
  assert.equal(pids.length, 1);
  assert.equal(alive(pids[0]), false);
  assert.deepEqual(runFiles(paths), []);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
});

test("a stop during the boot cancels the start", async (t) => {
  const { sdk, source, record } = await fixture(t, { bootTimeoutMs: 600000 });
  const emulator = source();
  await emulator.create(record);
  sdk.behaviour({ mode: "hang" });
  const start = emulator.start(record);
  const refused = assert.rejects(start, { code: "DEVICE_START_CANCELLED" });
  await waitUntil(() => sdk.emulators().length === 1, { describe: "the launch" });
  assert.equal(emulator.state(record).state, "starting");
  await emulator.stop(record);
  await refused;
  assert.equal(alive(sdk.launches()[0].pid), false);
  // A caller's signal does the same.
  const controller = new AbortController();
  const again = assert.rejects(emulator.start(record, { signal: controller.signal }), {
    code: "DEVICE_START_CANCELLED",
  });
  await waitUntil(() => sdk.emulators().length === 1, { describe: "the launch" });
  controller.abort();
  await again;
  assert.equal(alive(sdk.launches()[1].pid), false);
});

test("a device that ignores the kill request ends through SIGKILL", async (t) => {
  const { sdk, source, record, paths } = await fixture(t, {
    stopGraceMs: 200,
    killGraceMs: 1000,
  });
  const emulator = source();
  await emulator.create(record);
  sdk.behaviour({ mode: "stubborn" });
  await emulator.start(record);
  const [{ pid }] = sdk.launches();
  await emulator.stop(record);
  assert.equal(alive(pid), false);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
  // Nothing was saved, so the next start must not return to an older snapshot.
  sdk.behaviour({ mode: "boot" });
  await emulator.start(record);
  assert.equal(flag(sdk.launches()[1], "-no-snapshot-load"), true);
  assert.deepEqual(runFiles(paths), [`${record.id}.json`]);
});

test("occupied ports are skipped, and a full range refuses the start", async (t) => {
  const { sdk, ports, source, occupy, record } = await fixture(t, { pairs: 2 });
  const emulator = source();
  await emulator.create(record);
  const first = await occupy(ports.consolePorts.first);
  assert.deepEqual(await emulator.start(record), {
    serial: `emulator-${ports.consolePorts.last}`,
  });
  // A second device finds the first pair occupied and the second in use.
  const second = device("d-ffffffffffff", { image: sdk.manifest.image.id });
  await emulator.create(second);
  await assert.rejects(emulator.start(second), {
    code: "DEVICE_PORTS_BUSY",
    status: 409,
  });
  assert.equal(sdk.launches().length, 1);
  assert.equal(first.listening, true);
  await new Promise((done) => first.close(done));
  assert.deepEqual(await emulator.start(second), {
    serial: `emulator-${ports.consolePorts.first}`,
  });
  assert.equal(sdk.emulators().length, 2);
});

test("a foreign listener on the adb server port fails the start and stays alive", async (t) => {
  const { sdk, ports, source, occupy, record } = await fixture(t);
  const emulator = source();
  await emulator.create(record);
  const foreign = await occupy(ports.adbPort);
  await assert.rejects(emulator.start(record), { code: "DEVICE_ADB_FAILED" });
  assert.equal(foreign.listening, true);
  await new Promise((resolve, reject) => {
    const socket = net.connect(ports.adbPort, "127.0.0.1", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
  assert.equal(sdk.launches().length, 0);
  assert.deepEqual(sdk.servers(), []);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
});

test("a later process reclaims a device left running, and only its own", async (t) => {
  const { sdk, source, track, record, paths } = await fixture(t);
  // A source that is dropped without close(): its device and adb server stay.
  const dropped = source();
  await dropped.create(record);
  await dropped.start(record);
  const [{ pid }] = sdk.launches();
  // A run record whose pid belongs to another program, with its true start time.
  const other = track(spawn("sleep", ["600"], { stdio: "ignore" }));
  const foreign = "d-aaaaaaaaaaaa";
  fs.writeFileSync(
    path.join(paths.run, `${foreign}.json`),
    JSON.stringify({
      pid: other.pid,
      startTime: processIdentity(other.pid).startTime,
      consolePort: 1,
      adbPort: 2,
    }),
  );
  // One of ours by executable, but not the process the record was written for.
  const stale = "d-bbbbbbbbbbbb";
  fs.writeFileSync(
    path.join(paths.run, `${stale}.json`),
    JSON.stringify({ pid: other.pid, startTime: "long ago", consolePort: 3, adbPort: 4 }),
  );
  const later = source();
  assert.deepEqual(await later.reclaim([record]), [record.id]);
  await gone(pid);
  assert.equal(alive(other.pid), true);
  assert.deepEqual(runFiles(paths), []);
  assert.deepEqual(await later.reclaim([record]), []);
  // The reclaimed device lost what it had not saved: its next start is a cold boot.
  await later.start(record);
  assert.equal(flag(sdk.launches()[1], "-no-snapshot-load"), true);
  // A device of the running source is not a leftover.
  assert.deepEqual(await later.reclaim([record]), []);
  assert.equal(alive(sdk.launches()[1].pid), true);
});

test("the first boot turns off Chrome's first-run screens, once", async (t) => {
  const { sdk, source, record } = await fixture(t);
  const emulator = source();
  const fresh = { ...record, provisioned: false };
  await emulator.create(fresh);
  const serial = (await emulator.start(fresh)).serial;
  const steps = () =>
    sdk
      .calls()
      .map((call) => call.argv)
      .filter((argv) => /chrome/.test(argv.join(" ")));
  assert.deepEqual(steps(), [
    [
      "-s",
      serial,
      "shell",
      "echo 'chrome --disable-fre --no-default-browser-check --no-first-run'" +
        " > /data/local/tmp/chrome-command-line",
    ],
    [
      "-s",
      serial,
      "shell",
      "pm",
      "grant",
      "com.android.chrome",
      "android.permission.POST_NOTIFICATIONS",
    ],
  ]);
  await emulator.stop(fresh);
  assert.deepEqual(await emulator.start(fresh), { serial, provisioned: true });
  assert.equal(steps().length, 4);
  await emulator.stop(fresh);
  // A provisioned record needs no step. A failed step is reported as not done.
  assert.deepEqual(await emulator.start({ ...fresh, provisioned: true }), { serial });
  assert.equal(steps().length, 4);
  await emulator.stop(fresh);
  sdk.behaviour({ shell: { code: 1 } });
  assert.deepEqual(await emulator.start(fresh), { serial });
});

test("reset returns the device to the factory state on the pinned image", async (t) => {
  const { sdk, source, record, paths } = await fixture(t);
  const emulator = source();
  await emulator.create(record);
  await emulator.start(record);
  const folder = path.join(paths.avd, `${record.id}.avd`);
  assert.ok(fs.existsSync(path.join(folder, "userdata-qemu.img")));
  // Reset stops a running device first.
  assert.deepEqual(await emulator.reset(record), { image: sdk.manifest.image.id });
  assert.equal(alive(sdk.launches()[0].pid), false);
  assert.deepEqual(fs.readdirSync(folder), ["config.ini"]);
  assert.equal(hasSnapshot(paths, record.id), false);
  // A later release pins another image: reset moves the device onto it.
  const next = await sdk.pin({ image: { api: 37, revision: 2 } });
  await installFakeSdk(sdk.dataDir, next);
  const updated = source({ manifest: next });
  assert.deepEqual(await updated.reset(record), { image: "android-37-google_apis-r2" });
  assert.match(
    fs.readFileSync(path.join(folder, "config.ini"), "utf8"),
    /^image\.sysdir\.1=system-images\/android-37-google_apis-r2\/x86_64\/$/m,
  );
  assert.match(
    fs.readFileSync(path.join(folder, "config.ini"), "utf8"),
    /^target=android-37$/m,
  );
  // A device on the old image still starts while that image is installed.
  const old = device("d-cccccccccccc", { image: sdk.manifest.image.id });
  await updated.create(old);
  assert.match((await updated.start(old)).serial, /^emulator-/);
  await updated.remove(old);
  assert.equal(alive(sdk.launches().at(-1).pid), false);
  assert.deepEqual(fs.readdirSync(paths.avd).sort(), [
    `${record.id}.avd`,
    `${record.id}.ini`,
  ]);
  assert.equal(fs.existsSync(path.join(paths.logs, `${old.id}.log`)), false);
});

test("create, start and reset say why they cannot work", async (t) => {
  const { sdk, source, record, paths } = await fixture(t, { install: false });
  const absent = source();
  assert.equal(absent.availability(), "DEVICES_NOT_INSTALLED");
  await assert.rejects(absent.create(record), {
    code: "DEVICE_UNAVAILABLE",
    reason: "DEVICES_NOT_INSTALLED",
    status: 409,
  });
  await assert.rejects(absent.start(record), { code: "DEVICE_UNAVAILABLE" });
  // An update that got the emulator but not the new image: devices on the old
  // image work, a new device and a reset need the pinned one.
  await installFakeSdk(sdk.dataDir, sdk.manifest);
  const next = await sdk.pin({ image: { api: 37, revision: 2 } });
  const behind = source({ manifest: next });
  assert.equal(behind.availability(), null);
  await assert.rejects(behind.create({ ...record, image: next.image.id }), {
    code: "DEVICE_IMAGE_MISSING",
    image: next.image.id,
    status: 409,
  });
  await behind.create(record);
  await assert.rejects(behind.reset(record), { code: "DEVICE_IMAGE_MISSING" });
  // The refused reset left the device as it was.
  assert.ok(fs.existsSync(path.join(paths.avd, `${record.id}.avd`, "config.ini")));
  assert.match((await behind.start(record)).serial, /^emulator-/);
  await behind.stop(record);
  // While the SDK is being installed, updated or removed nothing starts.
  behind.sdk.operation = { kind: "install" };
  await assert.rejects(behind.start(record), {
    code: "DEVICE_UNAVAILABLE",
    reason: "DEVICES_OPERATION_RUNNING",
  });
  behind.sdk.operation = null;
  // A data partition needs its room on the disk.
  const roomy = source({
    manifest: {
      ...sdk.manifest,
      shape: { ...sdk.manifest.shape, dataPartition: "9000000000G" },
    },
    installed: sdk.manifest,
  });
  await assert.rejects(roomy.create(device("d-dddddddddddd", record)), {
    code: "DEVICE_DISK_SPACE",
  });
  assert.equal(fs.existsSync(path.join(paths.avd, "d-dddddddddddd.ini")), false);
});

test("close stops every device and the adb server, and nothing starts afterwards", async (t) => {
  const { sdk, source, record } = await fixture(t);
  const emulator = source();
  const second = device("d-eeeeeeeeeeee", { image: record.image });
  await emulator.create(record);
  await emulator.create(second);
  await Promise.all([emulator.start(record), emulator.start(second)]);
  assert.equal(sdk.emulators().length, 2);
  assert.equal(sdk.servers().length, 1);
  const exits = [];
  emulator.onExit = (id) => exits.push(id);
  await emulator.close({ graceMs: 3000 });
  assert.deepEqual(sdk.emulators(), []);
  assert.deepEqual(sdk.servers(), []);
  assert.deepEqual(sdk.pids().filter(alive), []);
  assert.deepEqual(exits, []);
  await assert.rejects(emulator.start(record), {
    code: "DEVICE_UNAVAILABLE",
    reason: "DEVICES_SHUTTING_DOWN",
  });
  // A device that does not answer in time is killed, not left behind.
  const stubborn = source();
  sdk.behaviour({ mode: "stubborn" });
  await stubborn.start(record);
  const pid = sdk.launches().at(-1).pid;
  await stubborn.close({ graceMs: 100 });
  assert.equal(alive(pid), false);
});
