import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  fakeAndroidSdk,
  freeDevicePorts,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import { AndroidSdk } from "../../server/features/devices/android-sdk.js";
import { deviceEnvironment } from "../../server/features/devices/device-paths.js";
import { EmulatorSource } from "../../server/features/devices/emulator-source.js";

// What the emulator source does when two things happen at once: a shutdown during a
// start, a death during the boot poll, a stop that failed and is tried again, a
// reclaim beside a new start. Against the fake emulator and the fake adb; each test
// names the moment it needs through a hook of its own instead of waiting for a
// duration, and ends with no process and no folder left.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = (pid) => waitUntil(() => !alive(pid), { describe: `pid ${pid} to end` });

async function fixture(t, options = {}) {
  const sdk = await fakeAndroidSdk();
  const ports = await freeDevicePorts(2);
  await installFakeSdk(sdk.dataDir, sdk.manifest);
  const sources = [];
  const source = (overrides = {}) => {
    const made = new EmulatorSource({
      dataDir: sdk.dataDir,
      manifest: sdk.manifest,
      host: sdk.host,
      sdk: new AndroidSdk({
        dataDir: sdk.dataDir,
        manifest: sdk.manifest,
        host: sdk.host,
        problem: () => null,
      }),
      identity: sdk.identity,
      pollMs: 20,
      stopGraceMs: 5000,
      killGraceMs: 2000,
      bootTimeoutMs: 600000,
      ...ports,
      ...options,
      ...overrides,
    });
    sources.push(made);
    return made;
  };
  t.after(async () => {
    for (const made of sources) await made.close({ graceMs: 1000 });
    const recorded = await sdk.cleanup();
    assert.deepEqual(recorded.filter(alive), []);
    assert.equal(fs.existsSync(sdk.root), false);
  });
  const record = {
    id: "d-0123456789ab",
    provisioned: true,
    image: sdk.manifest.image.id,
  };
  // Every start and stop of the adb server and every counted call has settled.
  const quiet = async (emulator) => {
    await emulator.serverQueue.idle();
    await emulator.adb.chain.catch(() => {});
    await waitUntil(() => emulator.adb.active === 0, {
      describe: "the adb calls to end",
    });
    await emulator.serverQueue.idle();
    await emulator.adb.chain.catch(() => {});
  };
  const getprops = () =>
    sdk.calls().filter(({ argv }) => argv.includes("sys.boot_completed")).length;
  return { sdk, ports, source, record, paths: sdk.paths, quiet, getprops };
}

test("a start that waits for the adb server when the source closes spawns nothing", async (t) => {
  const { sdk, source, record, quiet } = await fixture(t);
  const emulator = source();
  await emulator.create(record);
  const starting = emulator.start(record);
  // The start is past its first check and waits for the adb server.
  const closing = emulator.close({ graceMs: 500 });
  await assert.rejects(starting, { code: "DEVICE_START_CANCELLED", status: 409 });
  await closing;
  await quiet(emulator);
  assert.deepEqual(sdk.launches(), []);
  assert.equal(emulator.processes.size, 0);
  assert.equal(emulator.reserved.size, 0);
  assert.equal(emulator.users, 0);
  assert.equal(emulator.adb.server, null);
  assert.deepEqual(sdk.servers(), []);
  assert.deepEqual(sdk.pids().filter(alive), []);
});

test("a start that looks for its ports when the source closes spawns nothing", async (t) => {
  const { sdk, ports, source, record, quiet } = await fixture(t);
  let closing = null;
  const emulator = source({
    // Read when the start begins to look for free ports: the adb server is up then.
    consolePorts: {
      get first() {
        closing ??= emulator.close({ graceMs: 500 });
        return ports.consolePorts.first;
      },
      last: ports.consolePorts.last,
    },
  });
  await emulator.create(record);
  await assert.rejects(emulator.start(record), { code: "DEVICE_START_CANCELLED" });
  assert.notEqual(closing, null);
  await closing;
  await quiet(emulator);
  assert.deepEqual(sdk.launches(), []);
  assert.equal(emulator.processes.size, 0);
  assert.equal(emulator.reserved.size, 0);
  assert.equal(emulator.adb.server, null);
  assert.deepEqual(sdk.pids().filter(alive), []);
});

test("a device that dies between two boot checks gets no further adb call", async (t) => {
  const { sdk, source, record, quiet, getprops } = await fixture(t);
  const emulator = source();
  await emulator.create(record);
  sdk.behaviour({ mode: "hang" });
  // The poll interval is read when the wait between two checks begins: the first
  // check is answered then, and the device dies during the wait.
  let killed = null;
  Object.defineProperty(emulator, "pollMs", {
    get() {
      if (killed === null) {
        killed = emulator.processes.get(record.id).pid;
        process.kill(killed, "SIGKILL");
      }
      return 600000;
    },
  });
  await assert.rejects(emulator.start(record), { code: "DEVICE_EXITED" });
  assert.notEqual(killed, null);
  await quiet(emulator);
  assert.equal(getprops(), 1);
  // Nobody uses the adb server any more: it is not started again for a dead device.
  assert.equal(emulator.adb.server, null);
  assert.deepEqual(sdk.servers(), []);
});

test("a device that dies during its first-boot steps gets no further adb call", async (t) => {
  const { sdk, source, record, quiet } = await fixture(t);
  const emulator = source();
  await emulator.create(record);
  const steps = [];
  const exec = emulator.adb.exec.bind(emulator.adb);
  emulator.adb.exec = async (serial, args, options) => {
    const answer = await exec(serial, args, options);
    if (args[0] === "shell" && !args.includes("sys.boot_completed")) {
      steps.push(args);
      // The device dies right after its first step was answered.
      process.kill(emulator.processes.get(record.id).pid, "SIGKILL");
      await waitUntil(() => emulator.state(record).state === "stopped", {
        describe: "the source to see the exit",
      });
    }
    return answer;
  };
  await assert.rejects(emulator.start({ ...record, provisioned: false }), {
    code: "DEVICE_EXITED",
  });
  await quiet(emulator);
  assert.equal(steps.length, 1);
  assert.equal(emulator.adb.server, null);
  assert.deepEqual(sdk.servers(), []);
});

test("a stop that failed is tried again by the next stop", async (t) => {
  // No grace after the signals: the stop gives up while the killed process has not
  // been collected yet, which is what a process that survives everything looks like.
  const { sdk, source, record } = await fixture(t, { stopGraceMs: 100, killGraceMs: 0 });
  const emulator = source();
  await emulator.create(record);
  sdk.behaviour({ mode: "stubborn" });
  await emulator.start(record);
  const [{ pid }] = sdk.launches();
  const first = emulator.stop(record);
  await assert.rejects(first, { code: "DEVICE_STOP_FAILED", status: 409 });
  // The device still counts as there, and a second stop is a new attempt.
  assert.equal(emulator.state(record).state, "stopping");
  const second = emulator.stop(record);
  assert.notEqual(second, first);
  await second;
  await gone(pid);
  assert.deepEqual(emulator.state(record), { state: "stopped", serial: null });
  // Reset and delete stop the device first and are not stuck on the old failure.
  await emulator.remove(record);
});

test("a reclaim removes only the run record it read", async (t) => {
  const { sdk, ports, source, record, paths } = await fixture(t);
  const later = source();
  await later.create(record);
  // What an earlier AgentPier process left: a running emulator and its run record.
  const console = ports.consolePorts.first;
  const leftover = spawn(
    paths.emulatorBin,
    ["-avd", record.id, "-ports", `${console},${console + 1}`],
    { env: deviceEnvironment(paths, { adbPort: ports.adbPort }), stdio: "ignore" },
  );
  const { pid } = leftover;
  await waitUntil(() => sdk.emulators().length === 1, { describe: "the launch" });
  const file = path.join(paths.run, `${record.id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid,
      startTime: sdk.identity(pid).startTime,
      consolePort: console,
      adbPort: console + 1,
    }),
  );
  // The reclaim has read the record and signalled the process; it now waits for it.
  const reclaiming = later.reclaim([record]);
  // Meanwhile the record becomes that of another process.
  const next = { pid: process.pid, startTime: "now", consolePort: 1, adbPort: 2 };
  fs.writeFileSync(file, JSON.stringify(next));
  assert.deepEqual(await reclaiming, [record.id]);
  await gone(pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), next);
  fs.rmSync(file);
  // A record nobody replaced leaves with its process, as before.
  fs.writeFileSync(file, JSON.stringify({ pid, startTime: "gone", consolePort: 1 }));
  assert.deepEqual(await later.reclaim([record]), []);
  assert.equal(fs.existsSync(file), false);
});
