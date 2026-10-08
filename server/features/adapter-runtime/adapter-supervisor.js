import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_PORT_PLACEHOLDER,
  ADAPTER_URL_PLACEHOLDER,
} from "../providers/adapter-launch.js";
import { writeDiagnostics } from "./adapter-diagnostics.js";
import { createAdapterListener } from "./adapter-listener.js";
import { unavailableResponse } from "./adapter-http.js";

export const ADAPTER_ENTRY = fileURLToPath(
  new URL("../../adapter-process.js", import.meta.url),
);

export const adapterExecArgv = (flags = process.allowedNodeEnvironmentFlags) =>
  flags.has("--use-system-ca") ? ["--use-system-ca"] : [];

// Trust-store settings only: Node's extra CA bundle, and the OpenSSL locations its
// system-CA loading honors (corporate setups use them on Linux). Never proxies or keys.
const CA_VARIABLES = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];

export function adapterEnvironment(cliEnv = {}, own = process.env) {
  const env = { PATH: own.PATH || "/usr/bin:/bin" };
  for (const name of CA_VARIABLES) {
    const value = cliEnv[name] || own[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * Returns only the fields the launch has: a launch without `env` keeps inheriting the
 * launcher's environment instead of getting an empty one. Every env value and argv
 * element is rewritten, including user text passed in argv; the launcher cannot tell
 * which entries the launch description produced. That is harmless: the replacement is
 * the session's fixed, non-secret loopback origin, never the token or the key.
 */
export function substituteAdapterUrl({ env, args }, url) {
  // The port placeholder (nono `--open-port`) is the same origin's port, equally public.
  const port = new URL(url).port;
  const swap = (value) =>
    value
      .replaceAll(ADAPTER_URL_PLACEHOLDER, url)
      .replaceAll(ADAPTER_PORT_PLACEHOLDER, port);
  return {
    ...(env
      ? { env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, swap(v)])) }
      : {}),
    ...(args ? { args: args.map(swap) } : {}),
  };
}

const running = (child) => child.exitCode === null && child.signalCode === null;
const exitOf = (child) =>
  running(child)
    ? new Promise((resolve) => child.once("exit", () => resolve()))
    : Promise.resolve();

/**
 * Starts the adapter for one session and keeps it running. The supervisor owns the
 * loopback port for the whole session (see adapter-listener.js); an adapter exit it did
 * not cause triggers a restart with the same configuration, bounded by `restart`.
 * `signal` cancels only the start; once resolved, `stop()` is the only way to end it.
 */
export async function startAdapter(config, options = {}) {
  const {
    restart: { max = 3, windowMs = 60_000, delayMs = 250 } = {},
    queue: { max: maxQueued, maxAgeMs } = {},
    cliEnv,
    signal,
    ...rest
  } = options;
  // Only the derived adapter env is kept; the CLI env (with its keys) is not retained.
  const spawnOptions = { ...rest, env: adapterEnvironment(cliEnv) };
  const diagnostics = {
    file: config?.diagnosticsPath ?? null,
    generation: config?.generation ?? null,
  };
  const giveUpResponse = unavailableResponse(config?.clientProtocol);
  let listener = null;
  let child;
  try {
    listener = await createAdapterListener({ maxQueued, maxAgeMs });
    child = await spawnAdapter(config, { ...spawnOptions, signal, port: listener.port });
  } catch (error) {
    listener?.close();
    error.reason ??= "listen";
    // A stop during the start is no failure; every other reason is a fixed enum.
    if (error.reason !== "aborted")
      recordSupervisor(diagnostics, {
        startFailed: error.reason,
        at: new Date().toISOString(),
      });
    throw error;
  }
  const { port } = listener;
  // `secret` holds the key and token while restarts may need them; dropped on stop/give-up.
  let secret = config;
  config = null;
  const attempts = []; // timestamps of restart attempts (sliding window)
  let total = 0,
    stopping = false,
    timer = null,
    starting = null, // AbortController of a restart attempt in flight
    startingChild = null, // its child process until it is ready or gone
    lastReason = "exited";
  const giveUp = () => {
    secret = null;
    // The port stays bound until the session ends, so nobody else can take it. The CLI
    // keeps running but every request gets a static 503 in its format until a reload;
    // only the `supervisor` diagnostics field records why (no UI hint before the doctor).
    listener.refuse(giveUpResponse);
    recordSupervisor(diagnostics, {
      restarts: total,
      lastReason,
      gaveUpAt: new Date().toISOString(),
    });
  };
  const scheduleRestart = () => {
    if (stopping || !secret) return;
    const now = Date.now();
    while (attempts.length && now - attempts[0] > windowMs) attempts.shift();
    if (attempts.length >= max) return giveUp();
    timer = setTimeout(async () => {
      timer = null;
      if (stopping || !secret) return;
      attempts.push(Date.now());
      total += 1;
      const controller = new AbortController();
      starting = controller;
      try {
        const next = await spawnAdapter(secret, {
          ...spawnOptions,
          signal: controller.signal,
          port,
          restarts: total,
          onSpawn: (spawned) => (startingChild = spawned),
        });
        starting = null;
        startingChild = null;
        if (stopping) return void next.kill("SIGKILL");
        watch(next);
      } catch (error) {
        starting = null;
        startingChild = null;
        lastReason = error.reason ?? "exited";
        scheduleRestart(); // a failed or timed-out start consumed this attempt
      }
    }, delayMs);
  };
  const watch = (next) => {
    child = next;
    listener.setTarget(next);
    // A child that is shutting down (or lost its channel) takes no new connections.
    const release = () => next === child && listener.setTarget(null);
    next.on("message", (message) => message?.type === "closing" && release());
    next.once("disconnect", release);
    next.once("exit", () => {
      if (next !== child) return;
      listener.setTarget(null);
      if (stopping) return;
      lastReason = "exited";
      scheduleRestart();
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
      secret = null;
      clearTimeout(timer);
      listener.refuse();
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
      await listener.close();
    },
  };
}

/**
 * Merges the supervisor record (give-up, start failure) into the adapter's last snapshot
 * of this generation (atomic, 0600, never throws). Values are fixed enums, counts and
 * timestamps only.
 */
function recordSupervisor({ file, generation }, supervisor) {
  if (!file) return;
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  if (!current || (generation !== null && current.generation !== generation))
    current = { version: 1 };
  writeDiagnostics(file, { ...current, generation, supervisor }, generation);
}

/**
 * One start attempt for the supervisor's `port`; resolves with the ready child. Rejects
 * only once a child it killed has exited (bounded), so nothing it started outlives it.
 */
export function spawnAdapter(
  config,
  {
    entry = ADAPTER_ENTRY,
    timeoutMs = 10_000,
    cliEnv,
    env = adapterEnvironment(cliEnv),
    signal,
    execArgv = adapterExecArgv(),
    port,
    restarts = 0,
    httpTimeouts,
    onSpawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: true,
      env,
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
      const error = Object.assign(new Error("the protocol adapter did not start"), {
        reason,
      });
      if (child.pid === undefined || !running(child)) return reject(error);
      child.kill("SIGKILL");
      const bound = setTimeout(() => reject(error), 1000);
      exitOf(child).then(() => {
        clearTimeout(bound);
        reject(error);
      });
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    const onAbort = () => fail("aborted");
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    // `on`, not `once`: a later error (a failed kill or send) must not go unhandled.
    child.on("error", () => fail("spawn"));
    // Fallback when the failed message was lost: the adapter's exit codes name the reason.
    child.once("exit", (code) => fail(code === 78 ? "config" : "exited"));
    child.on("message", (message) => {
      if (settled) return;
      // The adapter never binds; its ready echoes the supervisor's port. Any other
      // message (`failed`, or one not for this start) is a configuration failure.
      if (message?.type === "ready" && message.port === port) {
        settle();
        resolve(child);
      } else fail("config");
    });
    child.once("spawn", () =>
      child.send({ type: "start", config, port, restarts, httpTimeouts }),
    );
  });
}
