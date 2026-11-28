import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { isLoopbackAddress } from "../helpers/loopback-address.js";
import { AndroidSdk } from "../../server/features/devices/android-sdk.js";
import { DeviceActions } from "../../server/features/devices/device-actions.js";
import { DeviceService } from "../../server/features/devices/device-service.js";
import { hasAvd, hasSnapshot } from "../../server/features/devices/avd-files.js";
import { hostProblem } from "../../server/features/devices/device-availability.js";
import { DEVICE_PORTS } from "../../server/features/devices/device-paths.js";
import { EmulatorSource } from "../../server/features/devices/emulator-source.js";
import { tcpListeners } from "../../server/lib/tcp-listeners.js";

// The tests with Google's real emulator and adb. In the first a device is created,
// booted cold, stopped, booted from its snapshot, killed, booted cold again, reset
// and removed, and all the while nothing of the user's own Android setup is touched.
// In the second every device action (device-actions.js) runs once on a real device,
// through the device service, as a session's tools call them.
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
const listeners = (pids) => tcpListeners().filter((row) => pids.includes(row.pid));

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
      assert.ok(isLoopbackAddress(entry.address), JSON.stringify(entry));
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

test(
  "every device action works on a real device",
  { skip: required ? false : skip, timeout: contractTimeout(900000) },
  async (t) => {
    assert.equal(skip, false, "the contract is required here");
    const source = new EmulatorSource({
      dataDir,
      sdk,
      adbPort,
      consolePorts: { first: adbPort + 2, last: adbPort + 20 },
      bootTimeoutMs: contractTimeout(180000),
    });
    const service = new DeviceService({ dataDir, sdk, sources: { emulator: source } });
    const actions = new DeviceActions({ devices: service, dataDir });
    const area = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "device-contract-")),
    );
    const caller = { kind: "session", id: "contract", name: "Contract" };
    const run = (action, input = {}) =>
      actions.run(
        action,
        { device: created?.id, ...input },
        { caller, canCreate: () => true, area: () => area },
      );
    let created = null;
    t.after(async () => {
      if (created)
        await service.remove(created.id, { caller: { kind: "owner" } }).catch(() => {});
      await service.shutdown({ graceMs: 8000 });
      fs.rmSync(area, { recursive: true, force: true });
    });
    const timed = async (name, work) => {
      const from = Date.now();
      const value = await work();
      t.diagnostic(`${name}: ${Date.now() - from} ms`);
      return value;
    };
    const refused = (code) => (error) => error.code === code;
    // The overview once it shows what `wanted` looks for.
    const overview = (wanted, describe) =>
      until(
        async () => {
          const shown = await run("ui").catch((error) => {
            if (error.code !== "DEVICE_SCREEN_UNAVAILABLE") throw error;
            return null;
          });
          return shown && wanted(shown) ? shown : null;
        },
        60000,
        describe,
      );
    const numbered = (shown, pattern) =>
      Number(shown.elements.find((entry) => pattern.test(entry)).split(" ")[0]);

    await service.start();
    ({ device: created } = await run("create", {
      name: `Contract ${randomBytes(3).toString("hex")}`,
    }));
    assert.deepEqual(
      [created.state, created.own, created.manage],
      ["stopped", true, true],
    );
    // A number without an overview is refused, and the device is not started for it.
    await assert.rejects(run("tap", { element: 1 }), refused("DEVICE_ELEMENT_STALE"));
    assert.equal(service.device(created.id).state, "stopped");

    // The first action boots the device.
    const shot = await timed("screenshot with the cold boot", () => run("screenshot"));
    assert.deepEqual([shot.mimeType, shot.width, shot.height], ["image/png", 720, 1600]);
    assert.deepEqual([...shot.image.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    t.diagnostic(`screenshot: ${shot.image.length} bytes`);
    assert.equal((await run("list")).devices[0].state, "running");
    const again = await timed("screenshot", () => run("screenshot"));
    assert.equal(again.width, 720);

    // A URL opens in Chrome, whose first-run screens are off.
    assert.deepEqual(
      await timed("open URL", () => run("open_url", { url: "https://example.com/" })),
      { opened: "https://example.com/" },
    );
    const field = / EditText#url_bar /;
    const page = await timed("overview of Chrome", () =>
      overview(
        (shown) =>
          shown.package === "com.android.chrome" &&
          shown.elements.some((entry) => field.test(entry)),
        "Chrome with its address bar",
      ),
    );
    assert.ok(page.shown > 0 && page.shown === page.elements.length);
    assert.equal(page.truncated, false);
    await assert.rejects(
      run("open_url", { url: "agentpier-contract-nothing://x" }),
      refused("DEVICE_COMMAND_FAILED"),
    );

    // An input field: Chrome's address bar. Its number is tapped, text is typed
    // and read back from the next overview, character for character.
    const bar = numbered(page, field);
    assert.match(page.elements[bar - 1], /editable/);
    const tapped = await timed("tap by number", () => run("tap", { element: bar }));
    assert.ok(tapped.tapped.x > 0 && tapped.tapped.y > 0);
    const text = "a b %s|100%sure $HOME;`id`\"q\"'x'\\n&<>(){}*?!~# -d";
    // As an overview line quotes it.
    const quoted = (value) => JSON.stringify(value).slice(1, -1);
    const holds = (value) => (shown) =>
      shown.elements.some((entry) => field.test(entry) && entry.includes(quoted(value)));
    assert.deepEqual(await timed("type", () => run("type", { text })), {
      typed: text.length,
    });
    await overview(holds(text), "the typed text in the address bar");
    await timed("key", () => run("key", { key: "delete", count: 3 }));
    await overview(
      (shown) => holds(text.slice(0, -3))(shown) && !holds(text)(shown),
      "the text without its last three characters",
    );
    await assert.rejects(
      run("type", { text: "Grüße" }),
      refused("DEVICE_TEXT_UNSUPPORTED"),
    );
    await run("key", { key: "escape" });
    assert.deepEqual(
      (await timed("scroll", () => run("swipe", { scroll: "down" }))).swiped,
      { from: { x: 360, y: 1200 }, to: { x: 360, y: 400 } },
    );
    await run("tap", { x: 360, y: 800, longPress: true });
    await run("key", { key: "home" });

    // Apps: listed, launched by their launcher activity, stopped.
    const all = await timed("list apps", () => run("apps", { all: true }));
    assert.ok(all.packages.includes("com.android.chrome"), String(all.total));
    assert.ok(all.packages.includes("com.android.settings"));
    assert.ok(Array.isArray((await run("apps")).packages));
    assert.deepEqual(await run("app_launch", { package: "com.android.settings" }), {
      launched: "com.android.settings/.Settings",
    });
    await overview(
      (shown) => shown.package === "com.android.settings",
      "the settings in front",
    );
    assert.deepEqual(await run("app_stop", { package: "com.android.settings" }), {
      stopped: "com.android.settings",
    });
    await assert.rejects(
      run("app_launch", { package: "com.agentpier.contract.missing" }),
      refused("DEVICE_COMMAND_FAILED"),
    );

    // Files: a round trip, and an APK. The repository holds no APK, so the device's
    // own Easter egg is pulled and installed again over itself.
    const content = `contract ${randomBytes(8).toString("hex")}\n`;
    fs.writeFileSync(path.join(area, "notes.txt"), content);
    const remote = "/data/local/tmp/agentpier contract's notes.txt";
    assert.deepEqual(
      await timed("push", () => run("push", { path: "notes.txt", devicePath: remote })),
      { pushed: remote, bytes: content.length },
    );
    assert.deepEqual(
      await timed("pull", () => run("pull", { devicePath: remote, path: "back.txt" })),
      { pulled: "back.txt", bytes: content.length },
    );
    assert.equal(fs.readFileSync(path.join(area, "back.txt"), "utf8"), content);
    await assert.rejects(
      run("pull", { devicePath: remote, path: "../escaped.txt" }),
      refused("DEVICE_PATH_OUTSIDE"),
    );
    await assert.rejects(
      run("pull", { devicePath: "/data/local/tmp/agentpier-nothing", path: "x.txt" }),
      refused("DEVICE_FILE_NOT_FOUND"),
    );
    await assert.rejects(
      run("pull", { devicePath: "/data/local/tmp", path: "x.txt" }),
      refused("DEVICE_FILE_NOT_FOUND"),
    );
    const apk = await run("pull", {
      devicePath: "/system/app/EasterEgg/EasterEgg.apk",
      path: "egg.apk",
    });
    assert.ok(apk.bytes > 100000, String(apk.bytes));
    assert.deepEqual(await timed("install", () => run("install", { path: "egg.apk" })), {
      installed: "egg.apk",
      bytes: apk.bytes,
    });
    fs.writeFileSync(path.join(area, "broken.apk"), "no package");
    await assert.rejects(run("install", { path: "broken.apk" }), (error) => {
      t.diagnostic(`install of a broken file: ${error.detail}`);
      return error.code === "DEVICE_COMMAND_FAILED";
    });

    // The shell runs inside the device: its exit code, its output, its limits.
    assert.deepEqual(
      await timed("shell", () =>
        run("shell", { command: "getprop ro.build.version.sdk" }),
      ),
      { exitCode: 0, stdout: "36\n", stderr: "", truncated: false },
    );
    assert.deepEqual(await run("shell", { command: "echo out; echo err >&2; exit 7" }), {
      exitCode: 7,
      stdout: "out\n",
      stderr: "err\n",
      truncated: false,
    });
    const flood = await run("shell", { command: "yes" });
    assert.deepEqual(
      [flood.exitCode, flood.stdout.length, flood.truncated],
      [null, 65536, true],
    );
    await assert.rejects(
      run("shell", { command: "sleep 30", timeoutMs: 1000 }),
      refused("DEVICE_ADB_TIMEOUT"),
    );
    // The device still answers after a command was ended.
    assert.equal((await run("shell", { command: "echo alive" })).stdout, "alive\n");

    // Logs: the latest lines, and those of one app.
    const logs = await timed("logs", () => run("logs", { lines: 30 }));
    assert.equal(logs.lines.length, 30);
    for (const entry of logs.lines)
      assert.match(entry, /^\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /);
    const errors = await run("logs", { priority: "E", lines: 10 });
    for (const entry of errors.lines) assert.match(entry, /^\S+ \S+ +\d+ +\d+ [EF] /);
    const chrome = await run("logs", { package: "com.android.chrome", lines: 5 });
    assert.ok(chrome.lines.length > 0 || /not running/.test(chrome.note), chrome.note);
    assert.deepEqual(await run("logs", { package: "com.agentpier.contract.missing" }), {
      lines: [],
      truncated: false,
      note: "com.agentpier.contract.missing is not running.",
    });

    // Stopped and started again, a number of the earlier overview is stale.
    await run("ui");
    await run("tap", { element: 1 });
    assert.equal((await timed("stop", () => run("stop"))).device.state, "stopped");
    await assert.rejects(run("tap", { element: 1 }), refused("DEVICE_ELEMENT_STALE"));
    assert.equal(
      (await timed("start from the snapshot", () => run("start"))).device.state,
      "running",
    );
    await assert.rejects(run("tap", { element: 1 }), refused("DEVICE_ELEMENT_STALE"));
    const id = created.id;
    assert.deepEqual(await run("delete"), { deleted: { id, name: created.name } });
    created = null;
    assert.equal(hasAvd(source.paths, id), false);
  },
);
