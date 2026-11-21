import { spawn } from "node:child_process";
import { guardProcess } from "./process-guard.js";

// Codex (0.169+) syncs the curated plugin marketplace on startup: it runs
// `git ls-remote` and `git fetch` of github.com/openai/plugins into
// CODEX_HOME/.tmp/plugins as its own children. A test that ends or times out Codex
// before that finishes leaves the git processes behind, and the runner's leak sweep
// fails the whole run. Tests that start the real Codex turn the sync off.
export const CODEX_NO_PLUGIN_SYNC = ["-c", "features.plugins=false"];

/**
 * Runs the real `codex` once with `args` and resolves { status, signal, stdout,
 * stderr }. Plugin sync is off, stdin is closed, and Codex leads its own process
 * group: after `timeoutMs`, and in any case once `t` ends, the whole group is
 * stopped, so no child Codex started survives the test.
 */
export function runCodex(t, args, { cwd, env, timeoutMs = 20_000 }) {
  const child = spawn("codex", [...CODEX_NO_PLUGIN_SYNC, ...args], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  guardProcess(t, child, { group: true });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Gone already. */
    }
  };
  const timer = setTimeout(stop, timeoutMs);
  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      stop();
      resolve({ status, signal, stdout, stderr });
    });
  });
}
