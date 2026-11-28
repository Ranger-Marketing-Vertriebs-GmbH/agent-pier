import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import {
  fakeAndroidSdk,
  freeDevicePorts,
  installFakeSdk,
  waitUntil,
} from "../helpers/fake-android-sdk.js";
import { AdbClient } from "../../server/features/devices/adb-client.js";
import { writeAvd } from "../../server/features/devices/avd-files.js";
import { deviceEnvironment } from "../../server/features/devices/device-paths.js";
import { processIdentity } from "../../server/lib/process-identity.js";

// AgentPier's adb client and its private server, against the fake adb. Every test
// has its own ports and data folder and leaves no process behind.
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = (pid) => waitUntil(() => !alive(pid), { describe: `pid ${pid} to end` });

async function fixture(t) {
  const sdk = await fakeAndroidSdk();
  const ports = await freeDevicePorts(1);
  const paths = await installFakeSdk(sdk.dataDir, sdk.manifest);
  const env = deviceEnvironment(paths, { adbPort: ports.adbPort });
  const client = (options = {}) =>
    new AdbClient({ paths, port: ports.adbPort, identity: sdk.identity, ...options });
  const adb = client();
  const children = [];
  const listeners = [];
  t.after(async () => {
    await adb.stopServer();
    for (const listener of listeners)
      if (listener.listening) await new Promise((done) => listener.close(done));
    const recorded = await sdk.cleanup();
    for (const child of children) {
      child.kill("SIGKILL");
      await child.done;
    }
    assert.deepEqual(recorded.filter(alive), []);
    assert.equal(fs.existsSync(sdk.root), false);
  });
  const track = (child) => {
    child.done = new Promise((resolve) => child.once("close", resolve));
    children.push(child);
    return child;
  };
  // A fake device on the test's console port, booted.
  const device = async () => {
    const id = "d-0123456789ab";
    const console = ports.consolePorts.first;
    writeAvd(paths, {
      id,
      image: sdk.manifest.image.id,
      abi: "x86_64",
      shape: sdk.manifest.shape,
    });
    track(
      spawn(paths.emulatorBin, ["-avd", id, "-ports", `${console},${console + 1}`], {
        env,
        stdio: "ignore",
      }),
    );
    const serial = `emulator-${console}`;
    await waitUntil(
      async () =>
        (await adb.exec(serial, ["shell", "getprop", "sys.boot_completed"])).stdout ===
        "1\n",
      { describe: "the fake device's boot" },
    );
    return serial;
  };
  const listen = () =>
    new Promise((resolve) => {
      // It accepts a connection and never answers.
      const listener = net.createServer((socket) => {
        socket.on("error", () => {});
        socket.resume();
      });
      listeners.push(listener);
      listener.listen(ports.adbPort, "127.0.0.1", () => resolve(listener));
    });
  return { sdk, ports, paths, env, adb, client, device, listen, track };
}
const record = (paths) =>
  JSON.parse(fs.readFileSync(path.join(paths.run, "adb-server.json"), "utf8"));

test("the server is AgentPier's own foreground child on its private port", async (t) => {
  const { sdk, ports, paths, adb } = await fixture(t);
  await adb.startServer();
  const [server] = sdk.servers();
  assert.deepEqual(
    { port: server.port, daemon: server.daemon },
    { port: ports.adbPort, daemon: false },
  );
  const stored = record(paths);
  assert.deepEqual(stored, {
    pid: server.pid,
    startTime: processIdentity(server.pid).startTime,
    port: ports.adbPort,
  });
  assert.equal(fs.statSync(path.join(paths.run, "adb-server.json")).mode & 0o777, 0o600);
  const launch = sdk.calls().find((call) => call.argv.includes("nodaemon"));
  assert.deepEqual(launch.argv, [
    "-L",
    `tcp:localhost:${ports.adbPort}`,
    "server",
    "nodaemon",
  ]);
  assert.equal(launch.env.HOME, paths.home);
  assert.equal(launch.env.ANDROID_ADB_SERVER_PORT, String(ports.adbPort));
  assert.equal(launch.env.ADB_MDNS, "0");
  // The keys adb writes are the owner's only.
  assert.equal(launch.umask, 0o077);
  // A second start is the same server.
  await adb.startServer();
  assert.deepEqual(
    sdk.servers().map((entry) => entry.pid),
    [server.pid],
  );
  assert.deepEqual(await adb.devices(), []);
  await adb.stopServer();
  await gone(server.pid);
  assert.equal(fs.existsSync(path.join(paths.run, "adb-server.json")), false);
  await adb.stopServer();
});

test("a non-zero exit is an answer, and a call starts the server instead of a daemon", async (t) => {
  const { sdk, adb } = await fixture(t);
  const answer = await adb.exec(null, ["shell", "true"]);
  assert.equal(answer.code, 1);
  assert.match(answer.stderr, /no devices\/emulators found/);
  assert.equal(answer.stdout, "");
  assert.equal(answer.truncated, false);
  assert.deepEqual(
    sdk.servers().map((entry) => entry.daemon),
    [false],
  );
  for (const call of sdk.calls()) assert.equal(call.umask, 0o077);
});

test("output is cut at maxBytes and a slow command is killed", async (t) => {
  const { sdk, adb, client, device } = await fixture(t);
  const serial = await device();
  assert.deepEqual(await adb.devices(), [{ serial, state: "device" }]);
  sdk.behaviour({ shell: { stdout: "0123456789".repeat(20000) } });
  const cut = await adb.exec(serial, ["shell", "cat", "big"], { maxBytes: 1000 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.stdout.length, 1000);
  const whole = await adb.exec(serial, ["shell", "cat", "big"], { encoding: "buffer" });
  assert.equal(whole.truncated, false);
  assert.ok(Buffer.isBuffer(whole.stdout));
  assert.equal(whole.stdout.length, 200000);
  assert.equal(whole.code, 0);
  sdk.behaviour({ shell: { stdout: "late\n", delayMs: 600000 } });
  // The pid as the client got it: a loaded machine may reach the timeout before the
  // fake has recorded its call.
  const pids = [];
  const timed = client({
    spawn: (...args) => {
      const child = spawn(...args);
      pids.push(child.pid);
      return child;
    },
  });
  // It talks to the server that runs already.
  timed.server = adb.server;
  await assert.rejects(timed.exec(serial, ["shell", "sleep"], { timeoutMs: 300 }), {
    code: "DEVICE_ADB_TIMEOUT",
    status: 409,
  });
  assert.equal(pids.length, 1);
  await gone(pids[0]);
  // A caller's signal ends the command as well.
  const controller = new AbortController();
  const pending = timed.exec(serial, ["shell", "sleep"], { signal: controller.signal });
  await waitUntil(() => pids.length === 2, { describe: "the adb call" });
  controller.abort();
  await assert.rejects(pending, { code: "DEVICE_ADB_CANCELLED" });
  await gone(pids[1]);
  sdk.behaviour({ shell: { stdout: "typed\n" } });
  assert.equal((await adb.exec(serial, ["shell", "cat"], { input: "abc" })).code, 0);
});

test("a daemon an emulator's adb call left on the port is ended first", async (t) => {
  const { sdk, ports, paths, env, adb } = await fixture(t);
  // A plain client call without a server starts a daemon, as the emulator's does.
  await new Promise((resolve) =>
    execFile(paths.adbBin, ["start-server"], { env }, resolve),
  );
  const [daemon] = sdk.servers();
  assert.equal(daemon.daemon, true);
  process.kill(daemon.pid, "SIGTERM");
  await adb.startServer();
  await gone(daemon.pid);
  const [server] = sdk.servers();
  assert.deepEqual(
    { port: server.port, daemon: server.daemon },
    { port: ports.adbPort, daemon: false },
  );
  assert.ok(sdk.calls().some((call) => call.argv.join(" ") === "kill-server"));
});

test("a listener that is not adb keeps the port and stays alive", async (t) => {
  const { sdk, ports, paths, adb, listen } = await fixture(t);
  const foreign = await listen();
  await assert.rejects(adb.startServer(), { code: "DEVICE_ADB_FAILED", status: 409 });
  await assert.rejects(adb.exec(null, ["devices"]), { code: "DEVICE_ADB_FAILED" });
  assert.equal(foreign.listening, true);
  await new Promise((resolve, reject) => {
    const socket = net.connect(ports.adbPort, "127.0.0.1", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
  assert.deepEqual(sdk.servers(), []);
  assert.equal(fs.existsSync(path.join(paths.run, "adb-server.json")), false);
  // Once the port is free, the server starts.
  await new Promise((done) => foreign.close(done));
  await adb.startServer();
  assert.equal(sdk.servers().length, 1);
});

test("a later process reclaims the recorded server and no other pid", async (t) => {
  const { sdk, ports, paths, adb, client, track } = await fixture(t);
  await adb.startServer();
  const [left] = sdk.servers();
  // Another AgentPier process finds the record of the one that ended.
  const later = client();
  t.after(() => later.stopServer());
  assert.equal(await later.reclaimServer(), true);
  await gone(left.pid);
  assert.equal(fs.existsSync(path.join(paths.run, "adb-server.json")), false);
  assert.equal(await later.reclaimServer(), false);
  // A record whose pid now belongs to another program: only the record goes.
  const other = track(spawn("sleep", ["600"], { stdio: "ignore" }));
  fs.writeFileSync(
    path.join(paths.run, "adb-server.json"),
    JSON.stringify({
      pid: other.pid,
      startTime: processIdentity(other.pid).startTime,
      port: ports.adbPort,
    }),
  );
  assert.equal(await later.reclaimServer(), false);
  assert.equal(alive(other.pid), true);
  assert.equal(fs.existsSync(path.join(paths.run, "adb-server.json")), false);
  // A start with such a record leaves that pid alone too.
  fs.writeFileSync(
    path.join(paths.run, "adb-server.json"),
    JSON.stringify({ pid: other.pid, startTime: "never", port: ports.adbPort }),
  );
  await later.startServer();
  assert.equal(alive(other.pid), true);
  assert.equal(record(paths).pid, sdk.servers()[0].pid);
});
