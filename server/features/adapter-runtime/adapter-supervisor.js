import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADAPTER_URL_PLACEHOLDER } from "../providers/adapter-launch.js";
import { writeDiagnostics } from "./adapter-diagnostics.js";

export const ADAPTER_ENTRY = fileURLToPath(
  new URL("../../adapter-process.js", import.meta.url),
);

export const adapterExecArgv = (flags = process.allowedNodeEnvironmentFlags) =>
  flags.has("--use-system-ca") ? ["--use-system-ca"] : [];

export function adapterEnvironment(cliEnv = {}, own = process.env) {
  const env = { PATH: own.PATH || "/usr/bin:/bin" };
  const ca = cliEnv.NODE_EXTRA_CA_CERTS || own.NODE_EXTRA_CA_CERTS;
  if (ca) env.NODE_EXTRA_CA_CERTS = ca;
  return env;
}

export function substituteAdapterUrl({ env = {}, args = [] }, url) {
  const swap = (value) => value.replaceAll(ADAPTER_URL_PLACEHOLDER, url);
  return {
    env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, swap(v)])),
    args: args.map(swap),
  };
}

const running = (child) => child.exitCode === null && child.signalCode === null;
const exitOf = (child) =>
  running(child)
    ? new Promise((resolve) => child.once("exit", () => resolve()))
    : Promise.resolve();

export async function startAdapter(config, options = {}) {
  const { restart: { max = 3, windowMs = 60_000, delayMs = 250 } = {}, ...spawnOptions } =
    options;
  let child = await spawnAdapter(config, spawnOptions);
  const port = child.adapterPort;
  const attempts = []; // timestamps of restart attempts (sliding window)
  let total = 0,
    stopping = false,
    timer = null,
    starting = null, // AbortController of a restart attempt in flight
    startingChild = null, // its child process until it is ready or gone
    lastReason = "exited";
  const scheduleRestart = () => {
    if (stopping) return;
    const now = Date.now();
    while (attempts.length && now - attempts[0] > windowMs) attempts.shift();
    if (attempts.length >= max)
      return recordGiveUp(config.diagnosticsPath, { restarts: total, lastReason });
    timer = setTimeout(async () => {
      timer = null;
      if (stopping) return;
      attempts.push(Date.now());
      total += 1;
      const controller = new AbortController();
      starting = controller;
      try {
        const next = await spawnAdapter(config, {
          ...spawnOptions,
          signal: controller.signal,
          port,
          restarts: total,
          onSpawn: (spawned) => (startingChild = spawned),
        });
        starting = null;
        startingChild = null;
        if (stopping) {
          next.kill("SIGKILL");
          return;
        }
        if (next.adapterPort !== port) {
          next.kill("SIGKILL");
          lastReason = "bind";
          return scheduleRestart();
        }
        watch(next);
      } catch (error) {
        starting = null;
        startingChild = null;
        lastReason = error.reason ?? "exited";
        scheduleRestart(); // a failed rebind or start timeout consumed this attempt
      }
    }, delayMs);
  };
  const watch = (next) => {
    child = next;
    next.once("exit", () => {
      if (!stopping && next === child) {
        lastReason = "exited";
        scheduleRestart();
      }
    });
  };
  watch(child);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    get child() {
      return child;
    },
    restarts: () => total,
    startingPid: () => startingChild?.pid ?? null, // test seam for "stop waits for a starting child"
    async stop({ graceMs = 2000 } = {}) {
      stopping = true;
      clearTimeout(timer);
      const pending = startingChild;
      starting?.abort(); // spawnAdapter SIGKILLs a child that is still starting …
      if (pending) await exitOf(pending); // … and stop() waits until it is really gone
      const current = child;
      if (running(current)) {
        current.kill("SIGTERM");
        const kill = setTimeout(() => current.kill("SIGKILL"), graceMs);
        await exitOf(current);
        clearTimeout(kill);
      }
    },
  };
}

/** Merges the give-up record into the adapter's last snapshot (atomic, 0600, never throws). */
function recordGiveUp(file, { restarts, lastReason }) {
  if (!file) return;
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  writeDiagnostics(file, {
    ...current,
    supervisor: { restarts, lastReason, gaveUpAt: new Date().toISOString() },
  });
}

/** One start attempt; resolves with the ready child (`child.adapterPort` set). */
export function spawnAdapter(
  config,
  {
    entry = ADAPTER_ENTRY,
    timeoutMs = 10_000,
    cliEnv,
    signal,
    execArgv = adapterExecArgv(),
    port = 0,
    restarts = 0,
    onSpawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
      env: adapterEnvironment(cliEnv),
    });
    onSpawn?.(child);
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (reason) => {
      if (settled) return;
      settle();
      child.kill("SIGKILL");
      reject(Object.assign(new Error("the protocol adapter did not start"), { reason }));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    const onAbort = () => fail("aborted");
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => fail("spawn"));
    // Fallback when the failed message was lost: the adapter's exit codes name the reason.
    child.once("exit", (code) =>
      fail(code === 78 ? "config" : code === 71 ? "bind" : "exited"),
    );
    child.on("message", (message) => {
      if (settled) return;
      const port = message?.port;
      if (
        message?.type === "ready" &&
        Number.isInteger(port) &&
        port > 0 &&
        port < 65536
      ) {
        settle();
        child.adapterPort = port;
        resolve(child);
      } else fail(message?.reason === "bind" ? "bind" : "config");
    });
    child.once("spawn", () => child.send({ type: "start", config, port, restarts }));
  });
}
