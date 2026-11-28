import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../../lib/process-identity.js";
import { closeConnection } from "../../lib/socket-errors.js";
import { writePrivate, writePrivateText } from "../../lib/storage.js";
import { SyncQueue } from "../../lib/sync-queue.js";
import { requireSpace } from "../tools/pinned-download.js";
import { AdbClient, within } from "./adb-client.js";
import { androidManifest, androidPlatform } from "./android-manifest.js";
import { avdBytes, hasAvd, removeAvd, writeAvd } from "./avd-files.js";
import {
  DEVICE_PORTS,
  deviceEnvironment,
  devicePaths,
  ensureDeviceFolders,
  receiptFile,
} from "./device-paths.js";
import { deviceError } from "./device-source.js";
import { reclaimLeftovers } from "./emulator-leftovers.js";

/*
 * The device source for Google's Android Emulator (the contract is in
 * device-source.js). One device is one AVD written by avd-files.js and, while it
 * runs, one emulator process in its own process group with the private environment
 * of device-paths.js, loopback ports of AgentPier's own range and umask 077.
 *
 * What it keeps on disk besides the AVD:
 *   run/<id>.json     `{ pid, startTime, consolePort, adbPort }` while the process
 *                     exists; a later AgentPier process reclaims an orphan by it
 *   run/<id>.unclean  set at every spawn and removed only after `emu kill` saved the
 *                     quick-boot snapshot. While it is there the next start passes
 *                     `-no-snapshot-load`: a plain start would silently return to
 *                     the last snapshot and lose everything written since.
 *   logs/<id>.log     the emulator output of the last start
 *
 * What the pinned emulator (37.3.10) was seen to do, and the code relies on:
 * - `-ports <console>,<console + 1>` outside 5555 to 5585 works; the emulator logs
 *   one warning about the range and registers with the adb server of
 *   ANDROID_ADB_SERVER_PORT by itself as `emulator-<console>`. `adb connect` is never
 *   used: it would add a second transport to the same device.
 * - It never rewrites `config.ini` and creates its files with the process umask.
 * - After SIGKILL its helpers (netsimd, crashpad_handler) end by themselves; the
 *   lock files it leaves in the AVD folder do not block the next start.
 *
 * The source signals only processes it started or reclaimed by their run record
 * (emulator-leftovers.js); it never decides by `adb devices` what to stop, so an
 * emulator the user runs themselves is never touched.
 */
const shell = "/bin/sh";
const wrapper = ["-c", 'umask 077; exec "$@"', "sh"];
const gibibyte = 2 ** 30;
// Chrome's first-run screens, turned off once per factory state: its command-line
// file (read on a debuggable image) and the notification permission it would ask for.
const firstBootSteps = [
  [
    "shell",
    "echo 'chrome --disable-fre --no-default-browser-check --no-first-run'" +
      " > /data/local/tmp/chrome-command-line",
  ],
  ["shell", "pm", "grant", "com.android.chrome", "android.permission.POST_NOTIFICATIONS"],
];

// Whether loopback port `port` can be bound now.
const free = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer(closeConnection);
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

// "6G" -> bytes.
function partitionBytes(size) {
  const [, count, unit] = /^(\d+)([MG])$/.exec(size || "") || [];
  return count ? Number(count) * (unit === "G" ? gibibyte : 2 ** 20) : 0;
}

export class EmulatorSource {
  /**
   * - `sdk`: the AndroidSdk (`available()`, `operation`); `adb`: an AdbClient,
   *   made here when absent.
   * - `bootTimeoutMs`: how long a boot may take; `stopGraceMs`: how long `emu kill`
   *   may take before SIGTERM; `killGraceMs`: SIGTERM to SIGKILL; `pollMs`: between
   *   two boot checks.
   * - `spawn` and `identity` are replaced in tests.
   */
  constructor({
    dataDir,
    manifest = androidManifest,
    host = { platform: process.platform, arch: process.arch },
    adb,
    sdk,
    spawn = nodeSpawn,
    identity = processIdentity,
    bootTimeoutMs = 180000,
    stopGraceMs = 30000,
    killGraceMs = 5000,
    pollMs = 500,
    adbPort = DEVICE_PORTS.adbServer,
    consolePorts = { first: DEVICE_PORTS.consoleFirst, last: DEVICE_PORTS.consoleLast },
  }) {
    Object.assign(this, { manifest, host, sdk, spawn, identity });
    Object.assign(this, { bootTimeoutMs, stopGraceMs, killGraceMs, pollMs });
    Object.assign(this, { adbPort, consolePorts });
    this.paths = devicePaths(dataDir, manifest, host);
    this.env = deviceEnvironment(this.paths, { adbPort });
    this.abi = manifest.image.archives[androidPlatform(host.platform, host.arch)]?.abi;
    this.adb =
      adb || new AdbClient({ paths: this.paths, port: adbPort, spawn, identity });
    // id -> the live process of a device.
    this.processes = new Map();
    this.reserved = new Set();
    // The adb server runs while a device process exists or starts.
    this.users = 0;
    this.serverQueue = new SyncQueue();
    this.closed = false;
    /** Called for a device that ended by itself while running: `(id, { code, signal })`. */
    this.onExit = null;
  }
  runFile(id) {
    return path.join(this.paths.run, `${id}.json`);
  }
  uncleanFile(id) {
    return path.join(this.paths.run, `${id}.unclean`);
  }
  logFile(id) {
    return path.join(this.paths.logs, `${id}.log`);
  }
  hasImage(image) {
    return fs.existsSync(path.join(this.paths.image(image, this.abi), receiptFile));
  }
  /** Null, a host code or DEVICES_NOT_INSTALLED. */
  availability() {
    return this.sdk.available();
  }
  // Refuses while no device can run, or while the SDK is installed, updated or removed.
  #usable(image) {
    const reason = this.closed ? "DEVICES_SHUTTING_DOWN" : this.availability();
    if (reason) throw deviceError("DEVICE_UNAVAILABLE", { reason });
    if (this.sdk.operation)
      throw deviceError("DEVICE_UNAVAILABLE", { reason: "DEVICES_OPERATION_RUNNING" });
    // The image a device was made with can be gone after a half-finished update.
    if (!this.hasImage(image)) throw deviceError("DEVICE_IMAGE_MISSING", { image });
  }
  #write(record, image) {
    writeAvd(this.paths, {
      id: record.id,
      image,
      abi: this.abi,
      shape: this.manifest.shape,
    });
  }
  /** Writes the AVD of `record` on `record.image`. Needs room for its data partition. */
  async create(record) {
    this.#usable(record.image);
    ensureDeviceFolders(this.paths);
    await requireSpace(
      this.paths.avd,
      partitionBytes(this.manifest.shape.dataPartition) + gibibyte,
      "DEVICE_DISK_SPACE",
    ).catch((error) => {
      throw deviceError(error.code);
    });
    this.#write(record, record.image);
  }
  #acquireServer() {
    this.users++;
    return this.serverQueue.run(() => this.adb.startServer());
  }
  #releaseServer() {
    this.users--;
    this.serverQueue
      .run(() => (this.users === 0 ? this.adb.stopServer() : null))
      .catch(() => {});
  }
  async #ports() {
    const { first, last } = this.consolePorts;
    for (let port = first; port <= last; port += 2) {
      if (this.reserved.has(port)) continue;
      this.reserved.add(port);
      if ((await free(port)) && (await free(port + 1))) return port;
      this.reserved.delete(port);
    }
    throw deviceError("DEVICE_PORTS_BUSY");
  }
  #signal(entry, signal) {
    if (entry.done) return;
    entry.signalled = true;
    try {
      process.kill(-entry.pid, signal);
    } catch {
      entry.child.kill(signal);
    }
  }
  #spawn(record, consolePort, coldBoot) {
    const { shape } = this.manifest;
    const args = [
      "-avd",
      record.id,
      "-ports",
      `${consolePort},${consolePort + 1}`,
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-gpu",
      "swiftshader_indirect",
      "-cores",
      String(shape.cores),
      "-memory",
      String(shape.memoryMb),
      "-no-metrics",
      ...(coldBoot ? ["-no-snapshot-load"] : []),
    ];
    const log = fs.openSync(this.logFile(record.id), "w", 0o600);
    try {
      return this.spawn(shell, [...wrapper, this.paths.emulatorBin, ...args], {
        env: this.env,
        cwd: this.paths.home,
        stdio: ["ignore", log, log],
        detached: true,
      });
    } finally {
      fs.closeSync(log);
    }
  }
  // The process of a device from its spawn to its exit.
  #track(record, child, consolePort) {
    const { id } = record;
    const entry = {
      id,
      child,
      pid: child.pid,
      consolePort,
      adbPort: consolePort + 1,
      serial: `emulator-${consolePort}`,
      state: "starting",
      startedAt: Date.now(),
      done: false,
      result: null,
      booted: false,
      killRequested: false,
      signalled: false,
      cancelled: false,
      stopping: null,
    };
    entry.exited = new Promise((resolve) => {
      const finish = (result) => {
        if (entry.done) return;
        entry.done = true;
        entry.result = result;
        const unexpected = entry.state === "running";
        entry.state = "stopped";
        if (this.processes.get(id) === entry) this.processes.delete(id);
        this.reserved.delete(consolePort);
        fs.rmSync(this.runFile(id), { force: true });
        if (this.#saved(entry)) fs.rmSync(this.uncleanFile(id), { force: true });
        this.#releaseServer();
        resolve(result);
        if (unexpected)
          try {
            this.onExit?.(id, result);
          } catch {
            // A listener's failure is not the source's.
          }
      };
      child.once("exit", (code, signal) => finish({ code, signal }));
      child.once("error", () => finish({ code: null, signal: null }));
    });
    this.processes.set(id, entry);
    return entry;
  }
  // The device ended on `emu kill` alone and its snapshot is newer than its start.
  #saved(entry) {
    if (!entry.booted || !entry.killRequested || entry.signalled) return false;
    const folder = path.join(
      this.paths.avd,
      `${entry.id}.avd`,
      "snapshots",
      "default_boot",
    );
    try {
      const since = Math.floor(entry.startedAt / 1000) * 1000;
      return fs
        .readdirSync(folder)
        .some((name) => fs.statSync(path.join(folder, name)).mtimeMs >= since);
    } catch {
      return false;
    }
  }
  /**
   * Boots the device of `record` and resolves `{ serial }` once Android reports the
   * boot as complete, with `provisioned: true` when the first-boot steps of a record
   * with `provisioned: false` ran. Rejects with DEVICE_EXITED (with `exitCode`) as
   * soon as the process ends, DEVICE_BOOT_TIMEOUT after `bootTimeoutMs` (the process
   * group is killed), DEVICE_START_CANCELLED when `signal` aborts, a stop arrives or
   * the source closes, DEVICE_PORTS_BUSY, DEVICE_ADB_FAILED, DEVICE_UNAVAILABLE or
   * DEVICE_IMAGE_MISSING.
   *
   * A shutdown may come while the start waits (for the adb server, for its ports):
   * it is looked for after every wait, so no emulator is spawned once close() ran.
   * From the spawn on the process is in `processes`, where close() finds it.
   */
  async start(record, { signal } = {}) {
    const running = this.processes.get(record.id);
    if (running?.state === "running") return { serial: running.serial };
    if (running) throw deviceError("DEVICE_BUSY");
    this.#usable(record.image);
    const proceed = () => {
      if (this.closed || signal?.aborted) throw deviceError("DEVICE_START_CANCELLED");
    };
    proceed();
    ensureDeviceFolders(this.paths);
    if (!hasAvd(this.paths, record.id)) this.#write(record, record.image);
    let entry;
    try {
      await this.#acquireServer();
      proceed();
      const consolePort = await this.#ports();
      try {
        proceed();
        const coldBoot = fs.existsSync(this.uncleanFile(record.id));
        writePrivateText(this.uncleanFile(record.id), "");
        entry = this.#track(
          record,
          this.#spawn(record, consolePort, coldBoot),
          consolePort,
        );
      } catch (error) {
        this.reserved.delete(consolePort);
        throw error;
      }
    } catch (error) {
      if (!entry) this.#releaseServer();
      throw error;
    }
    let startTime = null;
    try {
      startTime = this.identity(entry.pid).startTime;
    } catch {
      // Without a start time a later process cannot reclaim it; nothing else changes.
    }
    if (!entry.done)
      writePrivate(this.runFile(record.id), {
        pid: entry.pid,
        startTime,
        consolePort: entry.consolePort,
        adbPort: entry.adbPort,
      });
    await this.#boot(entry, signal);
    let provisioned;
    if (record.provisioned === false) provisioned = await this.#provision(entry, signal);
    if (!this.#starting(entry)) throw this.#ended(entry);
    entry.booted = true;
    entry.state = "running";
    return { serial: entry.serial, ...(provisioned && { provisioned }) };
  }
  // The process is there and nothing has asked for its end: only then is adb called
  // for it. A call for a dead device would start the adb server again for nobody.
  #starting(entry) {
    return !entry.done && !entry.cancelled && !this.closed && entry.state === "starting";
  }
  // Ends a start that was cancelled while its process runs.
  async #cancel(entry) {
    entry.cancelled = true;
    this.#signal(entry, "SIGKILL");
    await entry.exited;
    throw deviceError("DEVICE_START_CANCELLED");
  }
  #ended(entry) {
    return entry.cancelled
      ? deviceError("DEVICE_START_CANCELLED")
      : deviceError("DEVICE_EXITED", {
          exitCode: entry.result?.code ?? null,
          signal: entry.result?.signal ?? null,
        });
  }
  async #boot(entry, signal) {
    let timer, abort;
    // Ends the wait between two checks, so no timer outlives the boot.
    const waiting = new AbortController();
    const interrupted = Promise.race([
      entry.exited.then(() => "exit"),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.bootTimeoutMs);
      }),
      new Promise((resolve) => {
        abort = () => resolve("abort");
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
    const booted = async () => {
      const answer = await this.adb
        .exec(entry.serial, ["shell", "getprop", "sys.boot_completed"], {
          timeoutMs: 10000,
          maxBytes: 64,
        })
        .catch(() => null);
      return answer?.code === 0 && answer.stdout.trim() === "1";
    };
    const pause = () =>
      delay(this.pollMs, null, { signal: waiting.signal }).catch(() => null);
    try {
      // What interrupted the wait or the check, if anything did: a device that died
      // meanwhile is not asked again.
      for (let outcome = null; ; outcome = await Promise.race([interrupted, pause()])) {
        if (!outcome && !this.#starting(entry)) outcome = "exit";
        outcome ??= await Promise.race([interrupted, booted()]);
        if (outcome === true) return;
        if (outcome === "exit") {
          await entry.exited;
          throw this.#ended(entry);
        }
        if (outcome === "abort") await this.#cancel(entry);
        if (outcome === "timeout") {
          this.#signal(entry, "SIGKILL");
          await entry.exited;
          throw deviceError("DEVICE_BOOT_TIMEOUT");
        }
      }
    } finally {
      clearTimeout(timer);
      waiting.abort();
      signal?.removeEventListener("abort", abort);
    }
  }
  // The first-boot steps: true when all ran. None is sent to a device that is gone.
  async #provision(entry, signal) {
    for (const args of firstBootSteps) {
      if (signal?.aborted) await this.#cancel(entry);
      if (!this.#starting(entry)) return false;
      const answer = await this.adb
        .exec(entry.serial, args, { timeoutMs: 30000, signal })
        .catch(() => null);
      if (signal?.aborted) await this.#cancel(entry);
      if (answer?.code !== 0) return false;
    }
    return true;
  }
  /**
   * Stops the device of `record`: `emu kill` (which saves the quick-boot snapshot),
   * SIGTERM to the process group after `stopGraceMs`, SIGKILL after `killGraceMs`.
   * A device that is still booting has nothing to save and is killed at once.
   * Rejects with DEVICE_STOP_FAILED when the process survives all of it; the next
   * call tries again (and so do reset and remove, which stop first).
   */
  stop(record) {
    const entry = this.processes.get(record.id);
    if (!entry) return Promise.resolve();
    if (!entry.stopping) {
      const attempt = this.#stop(entry, this.stopGraceMs);
      entry.stopping = attempt;
      attempt.catch(() => {
        if (entry.stopping === attempt) entry.stopping = null;
      });
    }
    return entry.stopping;
  }
  async #stop(entry, graceMs) {
    const gone = (ms) => within(ms, () => entry.done);
    if (entry.state === "starting") {
      entry.cancelled = true;
      this.#signal(entry, "SIGKILL");
    } else {
      entry.state = "stopping";
      entry.killRequested = true;
      const answer = await this.adb
        .exec(entry.serial, ["emu", "kill"], { timeoutMs: Math.min(graceMs, 10000) })
        .catch(() => null);
      if (answer?.code === 0 && (await gone(graceMs))) return;
      this.#signal(entry, "SIGTERM");
      if (await gone(this.killGraceMs)) return;
      this.#signal(entry, "SIGKILL");
    }
    if (!(await gone(this.killGraceMs))) throw deviceError("DEVICE_STOP_FAILED");
  }
  /** Factory state on the pinned image: the AVD is removed and written again. */
  async reset(record) {
    const image = this.manifest.image.id;
    this.#usable(image);
    await this.stop(record);
    this.#forget(record.id);
    this.#write(record, image);
    return { image };
  }
  async remove(record) {
    await this.stop(record);
    this.#forget(record.id);
  }
  #forget(id) {
    removeAvd(this.paths, id);
    for (const file of [this.uncleanFile(id), this.logFile(id), this.runFile(id)])
      fs.rmSync(file, { force: true });
  }
  state(record) {
    const entry = this.processes.get(record.id);
    return entry
      ? { state: entry.state, serial: entry.state === "running" ? entry.serial : null }
      : { state: "stopped", serial: null };
  }
  /** An adb command on the running device; the options of AdbClient#exec. */
  async exec(record, args, options) {
    const entry = this.processes.get(record.id);
    if (entry?.state !== "running") throw deviceError("DEVICE_NOT_RUNNING");
    return this.adb.exec(entry.serial, args, options);
  }
  /** The loopback ports the device's process holds: console and adb. */
  ports(record) {
    const entry = this.processes.get(record.id);
    return entry ? [entry.consolePort, entry.adbPort] : [];
  }
  diskBytes(record) {
    return avdBytes(this.paths, record.id);
  }
  /**
   * Stops what an earlier AgentPier process left running (emulator-leftovers.js) and
   * the adb server it left. Resolves the ids whose process was stopped; their next
   * start is a cold boot.
   */
  async reclaim() {
    const stopped = await reclaimLeftovers({
      run: this.paths.run,
      sdk: this.paths.sdk,
      graceMs: this.killGraceMs,
      identity: this.identity,
      live: (id) => this.processes.has(id),
    });
    if (!this.processes.size && !this.users)
      await this.serverQueue.run(() => this.adb.reclaimServer()).catch(() => {});
    return stopped;
  }
  /**
   * Stops every device and the adb server for a shutdown, within about `graceMs`:
   * `emu kill` for the running ones, SIGKILL for what is left then (its next start
   * is a cold boot). No device starts afterwards.
   */
  async close({ graceMs = 3000 } = {}) {
    this.closed = true;
    const end = Date.now() + graceMs;
    await Promise.all(
      [...this.processes.values()].map(async (entry) => {
        if (entry.state === "running") {
          entry.state = "stopping";
          entry.killRequested = true;
          await this.adb
            .exec(entry.serial, ["emu", "kill"], { timeoutMs: Math.max(1, graceMs) })
            .catch(() => null);
        } else if (entry.state === "starting") entry.cancelled = true;
        const left = entry.state === "stopping" ? Math.max(0, end - Date.now()) : 0;
        if (await within(left, () => entry.done)) return;
        this.#signal(entry, "SIGKILL");
        await within(1000, () => entry.done);
      }),
    );
    await this.serverQueue
      .run(() => this.adb.stopServer({ force: true }))
      .catch(() => {});
  }
}
