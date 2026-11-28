import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../../lib/process-identity.js";
import { tcpListeners } from "../../lib/tcp-listeners.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { DEVICE_PORTS, deviceEnvironment, ensureDeviceFolders } from "./device-paths.js";
import { deviceError } from "./device-source.js";

/*
 * AgentPier's own adb: a server on a private loopback port, started as a foreground
 * child (`adb -L tcp:localhost:<port> server nodaemon`), and the client calls that
 * talk to it. Nothing here uses adb's default port 5037 or the user's `~/.android`
 * (deviceEnvironment), and every process starts with umask 077, so the keys adb
 * writes are the owner's only.
 *
 * A client call without a server would make adb start a daemonized one, which
 * ignores SIGTERM on Linux. So `exec` starts the server first when it is not
 * running, and `startServer` first ends an adb server of ours that holds the port:
 * a running emulator calls adb itself and starts such a daemon when ours is gone.
 *
 * Only a server of ours is ever ended: the one `run/adb-server.json` records (by
 * pid, start time and executable), or a listener on the port whose process runs an
 * executable below this data folder's SDK. Any other listener is left alone, a
 * second AgentPier on the same host included (its adb server holds the connection
 * to its devices), and so is one that cannot be identified; the start then fails
 * with DEVICE_ADB_FAILED and `reason: "DEVICE_ADB_PORT_IN_USE"`.
 */
// `sh` sets the umask and replaces itself with the program: the pid is the program's.
const shell = "/bin/sh";
const wrapper = ["-c", 'umask 077; exec "$@"', "sh"];
const stderrBytes = 65536;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Whether something accepts connections on loopback port `port`. */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Resolves true once `check()` is true, false after `ms` without it. */
export async function within(ms, check, everyMs = 25) {
  for (const end = Date.now() + ms; ;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await delay(everyMs);
  }
}

/**
 * Whether process `pid` is the one a run record names: alive, started at
 * `startTime`, and running an executable below the SDK folder `sdk`. Anything else,
 * a pid the system gave to another program included, is not ours to signal.
 */
export function ownProcess({ pid, startTime }, sdk, identity = processIdentity) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !startTime || !alive(pid)) return false;
  try {
    const found = identity(pid);
    const root = fs.realpathSync(sdk);
    return found.startTime === startTime && found.executable.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

export class AdbClient {
  /**
   * `paths` are devicePaths(); `port` is the private server port; `env` the
   * environment of every adb process; `spawn`, `identity` and `listeners`
   * (tcpListeners) are replaced in tests.
   */
  constructor({
    paths,
    port = DEVICE_PORTS.adbServer,
    env = deviceEnvironment(paths, { adbPort: port }),
    spawn = nodeSpawn,
    identity = processIdentity,
    listeners = tcpListeners,
  }) {
    Object.assign(this, { paths, port, env, spawn, identity, listeners });
    this.recordFile = path.join(paths.run, "adb-server.json");
    // The server child of this process, and the chain its starts and stops run on.
    this.server = null;
    this.chain = Promise.resolve();
    // Client calls under way, and their processes.
    this.active = 0;
    this.clients = new Set();
  }
  #serial(task) {
    const next = this.chain.catch(() => {}).then(task);
    this.chain = next;
    return next;
  }
  #spawn(args, options) {
    return this.spawn(shell, [...wrapper, this.paths.adbBin, ...args], {
      env: this.env,
      cwd: this.paths.home,
      ...options,
    });
  }
  // One client call, without making sure that the server runs.
  #client(
    args,
    { timeoutMs = 30000, maxBytes = 1048576, input, signal, encoding = "utf8" } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(deviceError("DEVICE_ADB_CANCELLED"));
      let child;
      try {
        child = this.#spawn(args, {
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch {
        return reject(deviceError("DEVICE_ADB_FAILED"));
      }
      this.clients.add(child);
      const chunks = [];
      let size = 0,
        errors = "",
        truncated = false,
        reason = null;
      const end = (why) => {
        reason ??= why;
        child.kill("SIGKILL");
      };
      child.stdout.on("data", (chunk) => {
        if (truncated) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          // Enough: a command that never ends would otherwise run into the timeout.
          truncated = true;
          chunk = chunk.subarray(0, room);
          end(null);
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => {
        if (errors.length < stderrBytes) errors = (errors + text).slice(0, stderrBytes);
      });
      if (input !== undefined) {
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
      const timer = setTimeout(() => end("DEVICE_ADB_TIMEOUT"), timeoutMs);
      const abort = () => end("DEVICE_ADB_CANCELLED");
      signal?.addEventListener("abort", abort, { once: true });
      const settle = () => {
        this.clients.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      child.once("error", () => {
        settle();
        reject(deviceError("DEVICE_ADB_FAILED"));
      });
      child.once("close", (code) => {
        settle();
        if (reason) return reject(deviceError(reason));
        const stdout = Buffer.concat(chunks);
        resolve({
          stdout: encoding === "buffer" ? stdout : stdout.toString(encoding),
          stderr: errors,
          code,
          truncated,
        });
      });
    });
  }
  // Ends the server an earlier AgentPier process recorded, if it still is that one.
  async #reclaimRecorded() {
    let stored = null;
    try {
      stored = readJSON(this.recordFile, null);
    } catch {
      // A damaged record names nothing.
    }
    if (!stored) return false;
    const own = () => ownProcess(stored, this.paths.sdk, this.identity);
    let stopped = false;
    try {
      if (own()) {
        process.kill(stored.pid, "SIGTERM");
        if (!(await within(2000, () => !alive(stored.pid))) && own())
          process.kill(stored.pid, "SIGKILL");
        await within(2000, () => !alive(stored.pid));
        stopped = true;
      }
    } catch {
      // Gone meanwhile.
    }
    fs.rmSync(this.recordFile, { force: true });
    return stopped;
  }
  // Whether every process that listens on the port runs an executable of this data
  // folder's SDK. False for any other program and whenever that cannot be told.
  #ours() {
    try {
      const pids = [
        ...new Set(this.listeners({ port: this.port }).map((row) => row.pid)),
      ];
      const root = fs.realpathSync(this.paths.sdk) + path.sep;
      return (
        pids.length > 0 &&
        pids.every((pid) => this.identity(pid).executable.startsWith(root))
      );
    } catch {
      return false;
    }
  }
  // Asks an adb server of ours that holds the port to end. True when the port is free
  // then; a listener that is not ours is not asked and keeps the port.
  async #freePort() {
    if (!(await listening(this.port))) return true;
    if (!this.#ours()) return false;
    const answer = await this.#client(["kill-server"], { timeoutMs: 5000 }).catch(
      () => null,
    );
    // Whatever refuses adb's request is not an adb server: nothing to wait for.
    if (answer?.code !== 0) return !(await listening(this.port));
    return within(3000, async () => !(await listening(this.port)));
  }
  /**
   * Starts the server as a child of this process and writes `run/adb-server.json`
   * (`{ pid, startTime, port }`). Nothing happens when it runs already. Throws
   * DEVICE_ADB_FAILED with `reason: "DEVICE_ADB_PORT_IN_USE"` when the port is held
   * by something that is not ours, and plain DEVICE_ADB_FAILED when the server does
   * not come up.
   */
  startServer() {
    return this.#serial(() => this.#start());
  }
  async #start() {
    if (this.server) return;
    ensureDeviceFolders(this.paths);
    await this.#reclaimRecorded();
    if (!(await this.#freePort()))
      throw deviceError("DEVICE_ADB_FAILED", { reason: "DEVICE_ADB_PORT_IN_USE" });
    let child;
    const log = fs.openSync(path.join(this.paths.logs, "adb-server.log"), "w", 0o600);
    try {
      child = this.#spawn(["-L", `tcp:localhost:${this.port}`, "server", "nodaemon"], {
        stdio: ["ignore", log, log],
        // Its own process group: a signal to AgentPier's group does not end it
        // before the devices are stopped.
        detached: true,
      });
    } catch {
      throw deviceError("DEVICE_ADB_FAILED");
    } finally {
      fs.closeSync(log);
    }
    let gone = false;
    child.once("error", () => (gone = true));
    child.once("exit", () => {
      gone = true;
      if (this.server !== child) return;
      this.server = null;
      fs.rmSync(this.recordFile, { force: true });
    });
    const up =
      (await within(10000, async () => gone || (await listening(this.port)))) &&
      !gone &&
      (await this.#client(["devices"], { timeoutMs: 10000 }).catch(() => null))?.code ===
        0;
    if (!up || gone) {
      if (!gone) child.kill("SIGKILL");
      throw deviceError("DEVICE_ADB_FAILED");
    }
    let startTime = null;
    try {
      startTime = this.identity(child.pid).startTime;
    } catch {
      // Without a start time the record never matches; `kill-server` still ends it.
    }
    this.server = child;
    writePrivate(this.recordFile, { pid: child.pid, startTime, port: this.port });
  }
  /**
   * Stops the server this process started; no other. Calls that are under way end
   * first, or are killed with `force` (a shutdown): a client that loses its server
   * would start a daemon in its place.
   */
  stopServer({ force = false } = {}) {
    return this.#serial(async () => {
      const child = this.server;
      if (!child) return;
      if (force) for (const client of this.clients) client.kill("SIGKILL");
      await within(force ? 2000 : 60000, () => this.active === 0);
      const ended = () => this.server !== child;
      child.kill("SIGTERM");
      if (!(await within(2000, ended))) child.kill("SIGKILL");
      await within(2000, ended);
    });
  }
  /**
   * Ends what an earlier AgentPier process of this data folder left on the port: the
   * server it recorded (verified by pid, start time and executable), and a daemon an
   * emulator's own adb call started there, which only `kill-server` ends. Another
   * program's listener stays. Resolves whether one ended.
   */
  reclaimServer() {
    return this.#serial(async () => {
      if (this.server) return false;
      const recorded = await this.#reclaimRecorded();
      if (!fs.existsSync(this.paths.adbBin) || !(await listening(this.port)))
        return recorded;
      return (await this.#freePort()) || recorded;
    });
  }
  /**
   * Runs `adb [-s <serial>] <args>` and resolves `{ stdout, stderr, code,
   * truncated }`; a non-zero exit is an answer, not an error. `stdout` is cut at
   * `maxBytes` (the command is ended then, `code` is null and `truncated` true) and
   * is a Buffer with `encoding: "buffer"`. Rejects with DEVICE_ADB_TIMEOUT after
   * `timeoutMs` (the command is killed), DEVICE_ADB_CANCELLED when `signal` aborts,
   * and DEVICE_ADB_FAILED when adb or its server cannot be started.
   */
  async exec(serial, args, options = {}) {
    // Counted on the chain of starts and stops, so no stop slips in between.
    await this.#serial(async () => {
      await this.#start();
      this.active++;
    });
    try {
      return await this.#client(serial ? ["-s", serial, ...args] : args, options);
    } finally {
      this.active--;
    }
  }
  /** The devices the server lists: `[{ serial, state }]`. */
  async devices() {
    const { stdout, code } = await this.exec(null, ["devices"]);
    if (code !== 0) throw deviceError("DEVICE_ADB_FAILED");
    return stdout
      .split("\n")
      .slice(1)
      .map((line) => /^(\S+)\t(\S+)/.exec(line))
      .filter(Boolean)
      .map(([, serial, state]) => ({ serial, state }));
  }
}
