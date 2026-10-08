// The private tmux server launches this helper so credentials never enter shell commands or tmux metadata.
import {
  readFileSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { spawnNativeProcess } from "./features/pipelines/native-process.js";
import {
  startAdapter,
  substituteAdapterUrl,
} from "./features/adapter-runtime/adapter-supervisor.js";

const payloadPath = process.argv[2];
let payload = null;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  unlinkSync(payloadPath);
} catch {
  payload = null;
  try {
    unlinkSync(payloadPath);
  } catch {}
  process.stderr.write("Unable to load the terminal launch configuration.\n");
  process.exitCode = 127;
}
if (payload) await launch(payload);

async function launch(payload) {
  // Terminal-generated SIGINT/SIGQUIT already reach the foreground child. Keep the
  // wrapper alive without forwarding a duplicate cancellation signal.
  process.on("SIGINT", () => {});
  process.on("SIGQUIT", () => {});
  // Registered before the adapter starts: a stop request during the start cancels it.
  let forward = null; // set once the CLI runs
  let early = null;
  const starting = new AbortController();
  for (const signal of ["SIGHUP", "SIGTERM"])
    process.on(signal, () => {
      if (forward) return forward(signal);
      early ??= signal;
      starting.abort();
    });
  let adapter = null;
  if (payload.adapter) {
    try {
      // The private adapter block (key, token) reaches only the supervisor; the CLI env
      // is used only to derive the adapter's CA settings.
      adapter = await startAdapter(payload.adapter, {
        cliEnv: payload.env,
        signal: starting.signal,
      });
    } catch {
      if (early) process.exitCode = 128 + constants.signals[early];
      else {
        process.stderr.write("Unable to start the protocol adapter.\n");
        process.exitCode = 127;
      }
      return;
    }
    if (early) {
      await adapter.stop();
      process.exitCode = 128 + constants.signals[early];
      return;
    }
    // Env values and argv only (also any nono argv composed by the server): the port is
    // known now, so placeholders become the session's loopback origin.
    Object.assign(payload, substituteAdapterUrl(payload, adapter.url));
    delete payload.adapter;
  }
  try {
    forward = runCli(payload, () => adapter?.stop());
  } catch {
    await adapter?.stop();
    process.stderr.write("Unable to load the terminal launch configuration.\n");
    process.exitCode = 127;
  }
}

/** Runs the CLI (or the headless pipeline group); returns the signal-forwarding function. */
function runCli(payload, onClose) {
  const observed = payload.observationPath
    ? openSync(payload.observationPath, "wx", 0o600)
    : null;
  const piped = typeof payload.initialInput === "string";
  const group = observed !== null ? spawnNativeProcess(payload) : null;
  if (group) {
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});
  }
  const child =
    group?.child ||
    spawn(payload.command, payload.args, {
      cwd: payload.cwd,
      env: payload.env,
      stdio: [
        piped ? "pipe" : "inherit",
        observed === null ? "inherit" : "pipe",
        "inherit",
      ],
    });
  if (piped && !group) {
    child.stdin.on("error", () => {});
    child.stdin.end(payload.initialInput);
  }
  if (group) child.stderr.pipe(process.stderr);
  let observedBytes = 0,
    observationFailed = false;
  if (observed !== null)
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (observationFailed) return;
      try {
        observedBytes += chunk.length;
        if (observedBytes > 64 * 1024 * 1024)
          throw new Error("Native observation limit reached");
        writeSync(observed, chunk);
      } catch {
        observationFailed = true;
        if (group) group.stop();
        else child.kill("SIGTERM");
        process.stderr.write("Unable to retain native pipeline output.\n");
      }
    });
  let shutdown;
  child.on("error", () => {
    process.stderr.write("Unable to start the selected CLI.\n");
    process.exitCode = 127;
  });
  child.on("close", async (code, signal) => {
    clearTimeout(shutdown);
    if (observed !== null) closeSync(observed);
    const result = group?.outcome();
    process.exitCode = observationFailed
      ? 125
      : group
        ? (result?.exitCode ?? (result?.signal ? 128 : 127))
        : (code ?? (signal ? 128 : 1));
    if (group && payload.outcomePath && result) {
      try {
        writeFileSync(
          payload.outcomePath,
          JSON.stringify({ exitCode: process.exitCode, groupStopped: true }),
          { mode: 0o600, flag: "wx" },
        );
      } catch {
        process.exitCode = 125;
      }
    }
    // Silent by design: the terminal belongs to the CLI, even while the adapter stops.
    try {
      await onClose();
    } catch {}
  });
  return (signal) => {
    if (shutdown) return;
    if (group) {
      group.stop();
      return;
    }
    child.kill(signal);
    shutdown = setTimeout(() => child.kill("SIGKILL"), 1000);
  };
}
