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
import { spawnNativeProcess } from "./features/pipelines/native-process.js";

const payloadPath = process.argv[2];
let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  unlinkSync(payloadPath);
  // Terminal-generated SIGINT/SIGQUIT already reach the foreground child. Keep the
  // wrapper alive without forwarding a duplicate cancellation signal.
  process.on("SIGINT", () => {});
  process.on("SIGQUIT", () => {});
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
  for (const signal of ["SIGHUP", "SIGTERM"]) {
    process.on(signal, () => {
      if (shutdown) return;
      if (group) {
        group.stop();
        return;
      }
      child.kill(signal);
      shutdown = setTimeout(() => child.kill("SIGKILL"), 1000);
    });
  }
  child.on("error", () => {
    process.stderr.write("Unable to start the selected CLI.\n");
    process.exitCode = 127;
  });
  child.on("close", (code, signal) => {
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
  });
} catch {
  try {
    unlinkSync(payloadPath);
  } catch {}
  process.stderr.write("Unable to load the terminal launch configuration.\n");
  process.exitCode = 127;
}
