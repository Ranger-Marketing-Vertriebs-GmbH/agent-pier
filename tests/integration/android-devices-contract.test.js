import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { AndroidSdk } from "../../server/features/devices/android-sdk.js";
import { hasAvd, hasSnapshot } from "../../server/features/devices/avd-files.js";
import { hostProblem } from "../../server/features/devices/device-availability.js";
import { DEVICE_PORTS } from "../../server/features/devices/device-paths.js";
import { EmulatorSource } from "../../server/features/devices/emulator-source.js";

// The one test with Google's real emulator and adb: a device is created, booted
// cold, stopped, booted from its snapshot, killed, booted cold again, reset and
// removed, and all the while nothing of the user's own Android setup is touched.
//
//   node scripts/android-device-assets.mjs --root <data folder>
//   AGENTPIER_ANDROID_CONTRACT_SDK=<data folder> node --test tests/integration/android-devices-contract.test.js
//
// The data folder is a disposable one that holds the installed pinned SDK
// (`<data folder>/devices/sdk`); the device and the processes' home are created in
// it and removed again. It needs a supported host (macOS arm64, or Linux x64 with a
// usable /dev/kvm), about 8 GB of disk and 4 GB of memory. One emulator runs at a
// time. AGENTPIER_ANDROID_CONTRACT_PORT moves the adb server port (and the console
// ports after it) away from AgentPier's own, for a host whose AgentPier runs devices.
const dataDir = process.env.AGENTPIER_ANDROID_CONTRACT_SDK || "";
const problem = hostProblem();
const sdk = dataDir && !problem ? new AndroidSdk({ dataDir }) : null;
const skip = !dataDir
  ? "set AGENTPIER_ANDROID_CONTRACT_SDK to a data folder with the pinned Android SDK"
  : problem
    ? `this host cannot run the emulator (${problem})`
    : !sdk.installed().current
      ? "the data folder does not hold the pinned Android SDK"
      : false;
// CI sets AGENTPIER_ANDROID_CONTRACT_REQUIRED: there a missing prerequisite (KVM
// that is not usable, an SDK that is not the pinned one) fails instead of skipping.
const required = !!process.env.AGENTPIER_ANDROID_CONTRACT_REQUIRED;
const adbPort =
  Number(process.env.AGENTPIER_ANDROID_CONTRACT_PORT) || DEVICE_PORTS.adbServer;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
async function until(check, ms, describe) {
  for (const end = Date.now() + contractTimeout(ms); ;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`Gave up waiting for ${describe}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const run = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 2 ** 20 });

// `roots` and every process below them, by parent or by process group.
function family(roots) {
  const rows = run("ps", ["-A", "-o", "pid=,ppid=,pgid="])
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid]) => pid > 0);
  const found = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent, group] of rows)
      if (!found.has(pid) && (found.has(parent) || roots.includes(group))) {
        found.add(pid);
        grew = true;
      }
  }
  return [...found];
}

// Every process that runs a program of the SDK folder `sdk`, which is this test's own.
const sdkProcesses = (sdk) =>
  run("ps", ["-A", "-ww", "-o", "pid=,command="])
    .split("\n")
    .filter((line) => line.includes(fs.realpathSync(sdk) + path.sep));

// The TCP sockets processes `pids` listen on: `[{ pid, address, port }]`.
function listeners(pids) {
  const rows =
    process.platform === "linux"
      ? run("ss", ["-H", "-ltnp"])
          .split("\n")
          .flatMap((line) => {
            const local = line.trim().split(/\s+/)[3] || "";
            return [...line.matchAll(/pid=(\d+)/g)].map((match) => ({
              pid: Number(match[1]),
              local,
            }));
          })
      : run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"])
          .split("\n")
          .slice(1)
          .map((line) => line.trim().split(/\s+/))
          .filter((columns) => columns.length >= 9)
          .map((columns) => ({ pid: Number(columns[1]), local: columns.at(-2) }));
  return rows
    .filter((row) => pids.includes(row.pid))
    .map(({ pid, local }) => ({
      pid,
      address: local.slice(0, local.lastIndexOf(":")).replace(/^\[|\]$/g, ""),
      port: Number(local.slice(local.lastIndexOf(":") + 1)),
    }));
}

// What the user's own Android folder holds: names, sizes and modification times.
function userAndroid() {
  const root = path.join(os.homedir(), ".android");
  const entries = [];
  const visit = (folder) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      entries.push(`${path.relative(root, file)} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) visit(file);
    }
  };
  try {
    visit(root);
  } catch (error) {
    if (error.code === "ENOENT" && !entries.length) return "absent";
    throw error;
  }
  return entries.join("\n");
}

test(
  "a real Android device is created, booted, stopped, restored, reset and removed",
  { skip: required ? false : skip, timeout: contractTimeout(900000) },
  async (t) => {
    assert.equal(skip, false, "the contract is required here");
    const before = userAndroid();
    const source = new EmulatorSource({
      dataDir,
      sdk,
      adbPort,
      consolePorts: { first: adbPort + 2, last: adbPort + 20 },
      bootTimeoutMs: contractTimeout(180000),
    });
    const { paths } = source;
    const record = {
      id: `d-${randomBytes(6).toString("hex")}`,
      image: source.manifest.image.id,
      provisioned: false,
    };
    const seen = new Set();
    t.after(async () => {
      await source.close({ graceMs: 5000 });
      await source.remove(record).catch(() => {});
      for (const pid of seen)
        if (alive(pid))
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Gone meanwhile.
          }
    });
    const log = () => fs.readFileSync(path.join(paths.logs, `${record.id}.log`), "utf8");
    const shell = async (...args) => {
      const answer = await source.exec(record, ["shell", ...args]);
      assert.equal(answer.code, 0, answer.stderr);
      return answer.stdout.trim();
    };
    const timed = async (work) => {
      const from = Date.now();
      const value = await work();
      return [value, (Date.now() - from) / 1000];
    };
    // Our processes right now, remembered for the check at the end.
    const ours = () => {
      const roots = [source.processes.get(record.id)?.pid, source.adb.server?.pid];
      const pids = family(roots.filter(Boolean));
      for (const pid of pids) seen.add(pid);
      return pids;
    };

    // What an earlier, aborted run left behind is not this run's device.
    await source.reclaim([]);
    assert.equal(source.availability(), null);
    await source.create(record);
    assert.equal(hasAvd(paths, record.id), true);
    assert.deepEqual(source.state(record), { state: "stopped", serial: null });

    const [started, coldSeconds] = await timed(() => source.start(record));
    t.diagnostic(`cold boot: ${coldSeconds.toFixed(1)} s`);
    assert.deepEqual(started, { serial: `emulator-${adbPort + 2}`, provisioned: true });
    assert.equal(await shell("getprop", "ro.build.version.sdk"), "36");
    assert.match(await shell("wm", "size"), /720x1600/);
    assert.match(await shell("wm", "density"), /320/);
    assert.match(
      await shell("cat", "/data/local/tmp/chrome-command-line"),
      /--disable-fre/,
    );
    assert.doesNotMatch(log(), /GRPC server/i);
    assert.deepEqual(await source.adb.devices(), [
      { serial: started.serial, state: "device" },
    ]);

    // Every listening socket of our processes is on loopback, and none is adb's
    // default port.
    const open = listeners(ours());
    t.diagnostic(
      `listeners: ${[...new Set(open.map((entry) => `${entry.address}:${entry.port}`))].join(", ")}`,
    );
    for (const port of [adbPort, adbPort + 2, adbPort + 3])
      assert.ok(
        open.some((entry) => entry.port === port),
        `port ${port} is listed`,
      );
    for (const entry of open) {
      assert.ok(["127.0.0.1", "::1"].includes(entry.address), JSON.stringify(entry));
      assert.notEqual(entry.port, 5037);
    }
    // Files the emulator and adb created are the owner's only.
    for (const folder of [path.join(paths.avd, `${record.id}.avd`), paths.home])
      for (const name of fs.readdirSync(folder, { recursive: true })) {
        const stat = fs.lstatSync(path.join(folder, name));
        if (!stat.isSymbolicLink())
          assert.equal(stat.mode & 0o077, 0, `${folder}/${name}`);
      }

    await shell("touch", "/data/local/tmp/contract-saved");
    const emulatorPid = source.processes.get(record.id).pid;
    const [, stopSeconds] = await timed(() => source.stop(record));
    t.diagnostic(`stop: ${stopSeconds.toFixed(1)} s`);
    assert.equal(alive(emulatorPid), false);
    assert.equal(hasSnapshot(paths, record.id), true);
    assert.deepEqual(source.state(record), { state: "stopped", serial: null });
    assert.equal(fs.existsSync(source.uncleanFile(record.id)), false);

    record.provisioned = true;
    const [, warmSeconds] = await timed(() => source.start(record));
    t.diagnostic(`boot from the snapshot: ${warmSeconds.toFixed(1)} s`);
    assert.ok(
      warmSeconds < coldSeconds,
      "the snapshot boot is faster than the cold boot",
    );
    assert.match(log(), /Successfully loaded snapshot/);
    assert.equal(
      await shell("ls", "/data/local/tmp/contract-saved"),
      "/data/local/tmp/contract-saved",
    );
    ours();

    // Killed without a snapshot: the next start is a cold boot that keeps what was
    // written, instead of returning to the older snapshot.
    await shell("touch", "/data/local/tmp/contract-unsaved");
    await shell("sync");
    const ended = new Promise((resolve) => {
      source.onExit = (id, result) => resolve({ id, ...result });
    });
    process.kill(-source.processes.get(record.id).pid, "SIGKILL");
    assert.deepEqual(await ended, { id: record.id, code: null, signal: "SIGKILL" });
    source.onExit = null;
    assert.equal(fs.existsSync(source.uncleanFile(record.id)), true);
    const [, recoverSeconds] = await timed(() => source.start(record));
    t.diagnostic(`cold boot after a kill: ${recoverSeconds.toFixed(1)} s`);
    assert.doesNotMatch(log(), /Successfully loaded snapshot/);
    assert.equal(
      await shell("ls", "/data/local/tmp/contract-unsaved"),
      "/data/local/tmp/contract-unsaved",
    );
    ours();

    // Reset stops the device and leaves a factory AVD; remove leaves nothing.
    assert.deepEqual(await source.reset(record), { image: record.image });
    assert.deepEqual(fs.readdirSync(path.join(paths.avd, `${record.id}.avd`)), [
      "config.ini",
    ]);
    await source.remove(record);
    assert.equal(hasAvd(paths, record.id), false);
    assert.equal(fs.existsSync(path.join(paths.avd, `${record.id}.avd`)), false);

    await source.close({ graceMs: 5000 });
    // The emulator leaves a watchdog of its own (`emulator -kill <pid> -sleep 20`)
    // that ends by itself right after it. Then nothing of this SDK runs any more.
    await until(
      () => [...seen].every((pid) => !alive(pid)) && !sdkProcesses(paths.sdk).length,
      30000,
      "every process of the device to end",
    );
    assert.equal(userAndroid(), before, "the user's ~/.android is untouched");
  },
);
