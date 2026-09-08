// Detached, private verification worker. Only this process signals the child groups it creates.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopOwnedGroup } from "./native-owned-group.js";
import { randomUUID } from "node:crypto";
const folder = process.argv[2];
function write(name, value) {
  const file = path.join(folder, name),
    temporary = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}
const request = JSON.parse(fs.readFileSync(path.join(folder, "request.json"), "utf8"));
const startedAt = new Date().toISOString();
let cancelled = false;
const heartbeat = setInterval(() => {
  write("heartbeat.json", { at: Date.now() });
}, 500);
write("heartbeat.json", { at: Date.now() });
const steps = [];
async function step(config, index) {
  const start = Date.now();
  let tail = "",
    logTruncated = false,
    timedOut = false,
    child,
    result;
  const stop = () => stopOwnedGroup(child);
  return new Promise((resolve) => {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./verify-executor.js", import.meta.url)),
        path.join(folder, "request.json"),
        String(index),
      ],
      {
        cwd: request.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      },
    );
    const output = (data) => {
      const next = tail + data.toString("utf8");
      logTruncated ||= next.length > 8192;
      tail = next.slice(-8192);
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.on("message", (message) => {
      result = message;
      clearTimeout(timeout);
      stop();
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, config.timeoutMs);
    const cancel = setInterval(() => {
      if (fs.existsSync(path.join(folder, "cancel"))) {
        cancelled = true;
        stop();
      }
    }, 50);
    let spawnError = false;
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", () => {
      clearTimeout(timeout);
      clearInterval(cancel);
      resolve({
        name: config.name,
        exitCode: spawnError ? null : (result?.exitCode ?? null),
        signal: result?.signal ?? null,
        blocking: config.blocking,
        timedOut,
        durationMs: Date.now() - start,
        logTail: tail,
        logTruncated,
      });
    });
  });
}

try {
  for (const [index, config] of request.steps.entries()) {
    if (fs.existsSync(path.join(folder, "cancel"))) {
      cancelled = true;
      break;
    }
    steps.push(await step(config, index));
    if (cancelled) break;
  }
  const failed = steps.filter((s) => s.blocking && (s.exitCode !== 0 || s.timedOut));
  const status = cancelled
    ? "unavailable"
    : failed.some((s) => s.timedOut)
      ? "timed-out"
      : failed.length
        ? "fail"
        : "pass";
  write("result.json", {
    status,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    quiesced: request.quiesced === true,
    quiescenceScope: "owned-process-group",
    cancelled,
  });
} catch {
  write("result.json", {
    status: "unavailable",
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    quiesced: false,
  });
} finally {
  clearInterval(heartbeat);
}
