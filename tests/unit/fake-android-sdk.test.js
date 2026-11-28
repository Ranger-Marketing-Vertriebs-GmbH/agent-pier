import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  fakeAndroidSdk,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import {
  DEVICE_PORTS,
  deviceEnvironment,
  devicePaths,
  ensureDeviceFolders,
  receiptFile,
} from "../../server/features/devices/device-paths.js";

// The fake `emulator` and `adb` executables every device test builds on, driven as
// AgentPier drives the real ones: as child processes with the device environment.
// Each test uses its own ports and checks that no process of it is left.
let nextPort = 46100 + (process.pid % 400) * 2;
const freePorts = async () => {
  for (;;) {
    const consolePort = (nextPort += 4);
    const busy = await Promise.all(
      [consolePort, consolePort + 1, consolePort + 2].map(
        (port) =>
          new Promise((resolve) => {
            const probe = net.createServer();
            probe.once("error", () => resolve(true));
            probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
          }),
      ),
    );
    if (!busy.includes(true))
      return { consolePort, adbPort: consolePort + 1, serverPort: consolePort + 2 };
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A child's end, once its output was read to the end.
const exited = (child) => child.done;
const output = (command, args, env) =>
  new Promise((resolve) =>
    execFile(command, args, { env }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    ),
  );

async function fixture(t) {
  const sdk = await fakeAndroidSdk();
  const ports = await freePorts();
  const paths = await installFakeSdk(sdk.dataDir, sdk.manifest);
  const env = deviceEnvironment(paths, { adbPort: ports.serverPort });
  const children = [];
  t.after(async () => {
    const recorded = await sdk.cleanup();
    await Promise.all(children.map(exited));
    // Nothing the fakes recorded is still running, and the folders are gone.
    assert.deepEqual(recorded.filter(alive), []);
    assert.equal(fs.existsSync(sdk.root), false);
  });
  const writeAvd = (id) => {
    fs.writeFileSync(
      path.join(paths.avd, `${id}.ini`),
      `avd.ini.encoding=UTF-8\npath=${paths.avd}/${id}.avd\ntarget=android-36\n`,
    );
    fs.mkdirSync(path.join(paths.avd, `${id}.avd`), { recursive: true });
    fs.writeFileSync(
      path.join(paths.avd, `${id}.avd`, "config.ini"),
      "abi.type=x86_64\nhw.lcd.width=720\n" +
        `image.sysdir.1=system-images/${sdk.manifest.image.id}/x86_64/\n`,
    );
  };
  const start = (child) => {
    children.push(child);
    child.done = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    let text = "";
    child.stdout?.on("data", (chunk) => (text += chunk));
    child.stderr?.on("data", (chunk) => (text += chunk));
    child.text = () => text;
    return child;
  };
  const emulator = (id, extra = []) =>
    start(
      spawn(
        paths.emulatorBin,
        [
          "-avd",
          id,
          "-ports",
          `${ports.consolePort},${ports.adbPort}`,
          "-no-window",
          ...extra,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  const server = () =>
    start(
      spawn(
        paths.adbBin,
        ["-L", `tcp:localhost:${ports.serverPort}`, "server", "nodaemon"],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
  const adb = (...args) => output(paths.adbBin, args, env);
  const serial = `emulator-${ports.consolePort}`;
  const listening = () =>
    waitUntil(() => sdk.servers().some((entry) => entry.port === ports.serverPort), {
      describe: "the fake adb server",
    });
  const booted = () =>
    waitUntil(
      async () =>
        (await adb("-s", serial, "shell", "getprop", "sys.boot_completed")).stdout ===
        "1\n",
      { describe: "the fake emulator's boot" },
    );
  return {
    sdk,
    ports,
    paths,
    env,
    writeAvd,
    emulator,
    server,
    adb,
    serial,
    listening,
    booted,
  };
}

test("the fake SDK is an installed SDK with receipts and working version calls", async (t) => {
  const { sdk, paths, env } = await fixture(t);
  assert.equal(
    paths.emulatorBin,
    path.join(sdk.dataDir, "devices/sdk/emulator/emulator"),
  );
  for (const [directory, name, version] of [
    [paths.emulator, "emulator", "37.3.10"],
    [paths.platformTools, "platformTools", "37.0.3"],
    [paths.image(), "image", "android-36-google_apis-r7"],
  ])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, receiptFile))), {
      version,
      sha256: sdk.manifest[name].archives["linux-x64"].sha256,
    });
  assert.equal(
    paths.image(),
    path.join(paths.images, "android-36-google_apis-r7/x86_64"),
  );
  assert.ok(fs.existsSync(path.join(paths.image(), "system.img")));
  assert.equal(
    (await output(paths.emulatorBin, ["-version"], env)).stdout,
    "Android emulator version 37.3.10.0 (build_id 16970787) (CL:N/A)\n",
  );
  const version = await output(paths.adbBin, ["version"], env);
  assert.match(
    version.stdout,
    /^Android Debug Bridge version 1\.0\.41\nVersion 37\.0\.3-/,
  );
  // Another pin is another set of archives with other digests.
  const later = await sdk.pin({ emulator: "37.4.1", build: "17000000" });
  assert.equal(later.emulator.version, "37.4.1");
  assert.notEqual(
    later.emulator.archives["linux-x64"].sha256,
    sdk.manifest.emulator.archives["linux-x64"].sha256,
  );
  assert.equal(
    later.platformTools.archives["linux-x64"].sha256,
    sdk.manifest.platformTools.archives["linux-x64"].sha256,
  );
});

test("the download host serves the pinned archives, ranges and failures", async (t) => {
  const { sdk } = await fixture(t);
  const archive = sdk.manifest.emulator.archives["linux-x64"];
  const read = async (response) => Buffer.from(await response.arrayBuffer());
  const whole = await read(await sdk.fetchImpl(archive.url));
  assert.equal(whole.length, archive.size);
  assert.equal(createHash("sha256").update(whole).digest("hex"), archive.sha256);
  const ranged = await sdk.fetchImpl(archive.url, { headers: { range: "bytes=100-" } });
  assert.equal(ranged.status, 206);
  assert.equal(
    ranged.headers.get("content-range"),
    `bytes 100-${archive.size - 1}/${archive.size}`,
  );
  assert.deepEqual(await read(ranged), whole.subarray(100));
  assert.equal(
    (await sdk.fetchImpl(archive.url, { headers: { range: `bytes=${archive.size}-` } }))
      .status,
    416,
  );
  assert.deepEqual(sdk.fetchImpl.requests.at(-2), {
    url: archive.url,
    range: "bytes=100-",
  });

  // A transfer that breaks off delivers its first bytes, then fails.
  sdk.fetchImpl.failAfter(64);
  const received = [];
  await assert.rejects(async () => {
    for await (const chunk of (await sdk.fetchImpl(archive.url)).body)
      received.push(chunk);
  });
  assert.deepEqual(Buffer.concat(received), whole.subarray(0, 64));

  sdk.fetchImpl.reset().corrupt("emulator-");
  const corrupted = await read(await sdk.fetchImpl(archive.url));
  assert.equal(corrupted.length, archive.size);
  assert.notDeepEqual(corrupted, whole);
  const other = sdk.manifest.platformTools.archives["linux-x64"];
  assert.equal(
    createHash("sha256")
      .update(await read(await sdk.fetchImpl(other.url)))
      .digest("hex"),
    other.sha256,
  );

  sdk.fetchImpl.reset().status(503);
  assert.equal((await sdk.fetchImpl(archive.url)).status, 503);

  // A stalled transfer ends only when the caller gives up.
  sdk.fetchImpl.reset().stall();
  const controller = new AbortController();
  const stalled = (await sdk.fetchImpl(archive.url, { signal: controller.signal })).body
    .getReader()
    .read();
  controller.abort(Error("gave up"));
  await assert.rejects(stalled, /gave up/);
});

test("the fake emulator refuses an AVD that is not there", async (t) => {
  const { emulator, writeAvd, paths, sdk } = await fixture(t);
  const missing = emulator("d-000000000001");
  assert.deepEqual(await exited(missing), { code: 1, signal: null });
  assert.match(missing.text(), /Unknown AVD name \[d-000000000001\]/);
  // An AVD without the keys the emulator needs is no AVD either.
  writeAvd("d-000000000002");
  fs.writeFileSync(
    path.join(paths.avd, "d-000000000002.avd", "config.ini"),
    "abi.type=x86_64\n",
  );
  const incomplete = emulator("d-000000000002");
  assert.deepEqual(await exited(incomplete), { code: 1, signal: null });
  assert.match(incomplete.text(), /Unknown AVD name/);
  assert.deepEqual(sdk.launches(), []);
});

test("a fake device boots, answers adb, and saves a snapshot on emu kill", async (t) => {
  const {
    sdk,
    ports,
    paths,
    env,
    writeAvd,
    emulator,
    server,
    adb,
    serial,
    listening,
    booted,
  } = await fixture(t);
  writeAvd("d-0000000000aa");
  const adbServer = server();
  await listening();
  const device = emulator("d-0000000000aa");
  await booted();
  assert.equal(
    (await adb("devices")).stdout,
    `List of devices attached\n${serial}\tdevice\n\n`,
  );
  assert.deepEqual(await adb("-s", serial, "shell", "echo", "hi"), {
    code: 0,
    stdout: "echo hi\n",
    stderr: "",
  });
  sdk.behaviour({ shell: { stdout: "boom\n", code: 3 } });
  const failed = await adb("-s", serial, "shell", "false");
  assert.equal(failed.code, 3);
  assert.equal(failed.stdout, "boom\n");
  const unknown = await adb("-s", "emulator-1", "shell", "true");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /adb: device 'emulator-1' not found/);

  // The launch and every adb call are recorded with the private environment.
  const [launch] = sdk.launches();
  assert.equal(launch.avd, "d-0000000000aa");
  assert.equal(launch.pid, device.pid);
  assert.deepEqual(launch.argv.slice(0, 4), [
    "-avd",
    "d-0000000000aa",
    "-ports",
    `${ports.consolePort},${ports.adbPort}`,
  ]);
  assert.equal(launch.env.HOME, paths.home);
  assert.equal(launch.env.ANDROID_AVD_HOME, paths.avd);
  assert.equal(launch.umask, process.umask());
  const call = sdk.calls().find((entry) => entry.argv.includes("devices"));
  assert.equal(call.env.HOME, paths.home);
  assert.equal(call.env.ANDROID_ADB_SERVER_PORT, String(ports.serverPort));
  assert.equal(call.env.ADB_MDNS, "0");
  assert.deepEqual(
    sdk.emulators().map((entry) => [entry.serial, entry.pid, entry.snapshotLoaded]),
    [[serial, device.pid, false]],
  );
  // A fake is a Node script: its identity names the launcher below the SDK.
  assert.equal(sdk.identity(device.pid).executable, fs.realpathSync(paths.emulatorBin));
  assert.equal(sdk.identity(adbServer.pid).executable, fs.realpathSync(paths.adbBin));
  assert.equal(sdk.identity(process.pid).executable, fs.realpathSync(process.execPath));
  assert.ok(fs.existsSync(path.join(paths.home, ".emulator_console_auth_token")));

  const marker = path.join(
    paths.avd,
    "d-0000000000aa.avd/snapshots/default_boot/snapshot.pb",
  );
  assert.equal(fs.existsSync(marker), false);
  assert.match((await adb("-s", serial, "emu", "kill")).stdout, /^OK: killing emulator/);
  assert.deepEqual(await exited(device), { code: 0, signal: null });
  assert.ok(fs.existsSync(marker));
  assert.equal((await adb("devices")).stdout, "List of devices attached\n\n");

  // The next start loads the snapshot, unless it is told not to.
  const again = emulator("d-0000000000aa");
  await booted();
  assert.equal(sdk.emulators()[0].snapshotLoaded, true);
  await adb("-s", serial, "emu", "kill");
  await exited(again);
  const cold = emulator("d-0000000000aa", ["-no-snapshot-load"]);
  await booted();
  assert.equal(sdk.emulators()[0].snapshotLoaded, false);
  assert.ok(sdk.launches().at(-1).argv.includes("-no-snapshot-load"));
  cold.kill("SIGTERM");
  assert.deepEqual(await exited(cold), { code: null, signal: "SIGTERM" });

  adbServer.kill("SIGTERM");
  assert.deepEqual(await exited(adbServer), { code: null, signal: "SIGTERM" });
  // Throughout, the only adb server was the foreground one: no daemon was started.
  assert.equal(
    sdk.calls().some((entry) => entry.argv.includes("fork-server")),
    false,
  );
  // The private environment keeps everything inside the data folder.
  assert.equal(env.ANDROID_SDK_ROOT, paths.sdk);
});

test("each mode of the fake emulator behaves as named", async (t) => {
  const { sdk, writeAvd, emulator, server, adb, serial, listening, booted } =
    await fixture(t);
  writeAvd("d-0000000000bb");
  server();
  await listening();
  const bootState = async () =>
    (await adb("-s", serial, "shell", "getprop", "sys.boot_completed")).stdout;

  sdk.behaviour({ mode: "die", dieMs: 1 });
  const dying = emulator("d-0000000000bb");
  assert.deepEqual(await exited(dying), { code: 1, signal: null });
  assert.match(dying.text(), /died before the boot/);

  // A hanging device is listed but never reports a completed boot.
  sdk.behaviour({ mode: "hang" });
  const hanging = emulator("d-0000000000bb");
  await waitUntil(() => sdk.emulators().length === 1, { describe: "the hanging device" });
  assert.equal(await bootState(), "\n");
  assert.equal(
    (await adb("devices")).stdout,
    `List of devices attached\n${serial}\toffline\n\n`,
  );
  assert.equal(sdk.emulators()[0].bootAt, null);
  // Killed before its boot, it has nothing to save.
  await adb("-s", serial, "emu", "kill");
  assert.deepEqual(await exited(hanging), { code: 0, signal: null });
  assert.equal(
    fs.existsSync(path.join(sdk.paths.avd, "d-0000000000bb.avd/snapshots")),
    false,
  );

  sdk.behaviour({ mode: "crash", crashMs: 1 });
  const crashing = emulator("d-0000000000bb");
  assert.deepEqual(await exited(crashing), { code: 1, signal: null });
  assert.match(crashing.text(), /Boot completed[\s\S]*fake crash/);
  assert.equal(
    fs.existsSync(path.join(sdk.paths.avd, "d-0000000000bb.avd/snapshots")),
    false,
  );
  assert.equal((await adb("-s", serial, "shell", "true")).code, 1);

  // A stubborn device ignores the kill request and SIGTERM; only SIGKILL ends it.
  sdk.behaviour({ mode: "stubborn" });
  const stubborn = emulator("d-0000000000bb");
  await booted();
  assert.equal((await adb("-s", serial, "emu", "kill")).code, 0);
  stubborn.kill("SIGTERM");
  // Both requests were delivered and answered, and the device still answers.
  assert.equal(await bootState(), "1\n");
  assert.equal(stubborn.exitCode, null);
  stubborn.kill("SIGKILL");
  assert.deepEqual(await exited(stubborn), { code: null, signal: "SIGKILL" });
});

test("a console port in use is a real conflict", async (t) => {
  const { ports, writeAvd, emulator } = await fixture(t);
  writeAvd("d-0000000000cc");
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(ports.consolePort, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => holder.close(resolve)));
  const refused = emulator("d-0000000000cc");
  assert.deepEqual(await exited(refused), { code: 1, signal: null });
  assert.match(refused.text(), /is in use \(EADDRINUSE\)/);
});

test("the adb server port belongs to one server", async (t) => {
  const { sdk, ports, server, adb, listening, env, paths } = await fixture(t);
  const first = server();
  await listening();
  const second = server();
  assert.deepEqual(await exited(second), { code: 1, signal: null });
  assert.match(second.text(), /cannot bind to 127\.0\.0\.1:\d+: Address already in use/);
  assert.equal(first.exitCode, null);
  // kill-server ends the server that listens there.
  assert.equal((await adb("kill-server")).code, 0);
  assert.deepEqual(await exited(first), { code: 0, signal: null });
  const none = await adb("kill-server");
  assert.equal(none.code, 1);
  assert.match(none.stderr, /cannot connect to daemon/);

  // Without a server, a client starts a daemon that only kill-server ends.
  const listed = await adb("devices");
  assert.equal(listed.stdout, "List of devices attached\n\n");
  assert.match(listed.stderr, /daemon not running; starting now at tcp:\d+/);
  const [daemon] = sdk.servers();
  assert.equal(daemon.daemon, true);
  assert.equal(daemon.port, ports.serverPort);
  process.kill(daemon.pid, "SIGTERM");
  assert.equal((await adb("devices")).stderr, "");
  assert.equal(sdk.servers()[0].pid, daemon.pid);
  assert.equal((await adb("kill-server")).code, 0);
  await waitUntil(() => !alive(daemon.pid), { describe: "the daemon's end" });

  // A listener that is not adb is neither used nor ended.
  const foreign = net.createServer((socket) => socket.on("error", () => {}).resume());
  await new Promise((resolve) => foreign.listen(ports.serverPort, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const blocked = server();
  assert.deepEqual(await exited(blocked), { code: 1, signal: null });
  const fault = await adb("kill-server");
  assert.equal(fault.code, 1);
  assert.match(fault.stderr, /protocol fault/);
  assert.equal(foreign.listening, true);

  // The fake never falls back to adb's default port.
  const { ANDROID_ADB_SERVER_PORT: _port, ...bare } = env;
  const refused = await output(paths.adbBin, ["devices"], bare);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refusing to use adb's default server port/);
  const explicit = await output(paths.adbBin, ["-P", "5037", "devices"], env);
  assert.match(explicit.stderr, /refusing to use adb's default server port/);
});

test("the device environment is private and drops inherited Android variables", () => {
  const paths = devicePaths("/data", undefined, { platform: "darwin", arch: "arm64" });
  assert.equal(paths.root, "/data/devices");
  assert.equal(paths.emulatorBin, "/data/devices/sdk/emulator/emulator");
  assert.equal(paths.adbBin, "/data/devices/sdk/platform-tools/adb");
  assert.equal(
    paths.image(),
    "/data/devices/sdk/system-images/android-36-google_apis-r7/arm64-v8a",
  );
  assert.equal(
    devicePaths("/data", undefined, { platform: "linux", arch: "x64" }).image(),
    "/data/devices/sdk/system-images/android-36-google_apis-r7/x86_64",
  );
  assert.equal(
    paths.image("old", "x86_64"),
    "/data/devices/sdk/system-images/old/x86_64",
  );
  assert.equal(paths.settingsFile, "/data/devices/settings.json");
  assert.equal(paths.devicesFile, "/data/devices/devices.json");
  const env = deviceEnvironment(paths, {
    adbPort: 47600,
    base: {
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      TMPDIR: "/tmp",
      ANDROID_SDK_ROOT: "/opt/android",
      ANDROID_SERIAL: "emulator-5554",
      ADB_VENDOR_KEYS: "/keys",
      ADB_MDNS: "1",
    },
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/data/devices/home",
    TMPDIR: "/data/devices/run/tmp",
    ANDROID_SDK_ROOT: "/data/devices/sdk",
    ANDROID_HOME: "/data/devices/sdk",
    ANDROID_AVD_HOME: "/data/devices/avd",
    ANDROID_USER_HOME: "/data/devices/home/.android",
    ANDROID_EMULATOR_HOME: "/data/devices/home/.android",
    ANDROID_ADB_SERVER_PORT: "47600",
    ADB_MDNS: "0",
  });
  // adb's default port, or none, is never AgentPier's own.
  assert.throws(() => deviceEnvironment(paths, { adbPort: 5037, base: {} }), TypeError);
  assert.throws(
    () => deviceEnvironment(paths, { adbPort: "47600", base: {} }),
    TypeError,
  );
  // Without a port it is AgentPier's fixed one.
  assert.equal(deviceEnvironment(paths, { base: {} }).ANDROID_ADB_SERVER_PORT, "47600");
  assert.deepEqual(DEVICE_PORTS, {
    adbServer: 47600,
    consoleFirst: 47602,
    consoleLast: 47620,
  });
});

test("the device folders are created for the owner only", async (t) => {
  const sdk = await fakeAndroidSdk({ platform: "darwin-arm64" });
  t.after(() => sdk.cleanup());
  assert.equal(sdk.key, "darwin-arm64");
  assert.deepEqual(sdk.host, { platform: "darwin", arch: "arm64" });
  ensureDeviceFolders(sdk.paths);
  for (const name of ["root", "sdk", "avd", "home", "downloads", "run", "tmp", "logs"])
    assert.equal(fs.statSync(sdk.paths[name]).mode & 0o777, 0o700, name);
  const paths = await installFakeSdk(sdk.dataDir, sdk.manifest);
  assert.ok(fs.existsSync(path.join(paths.image(), "system.img")));
  assert.ok(paths.image().endsWith("arm64-v8a"));
  await assert.rejects(installFakeSdk(sdk.dataDir, {}), /made by fakeAndroidSdk/);
});
