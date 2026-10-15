import { spawn } from "node:child_process";
import path from "node:path";
import { packageProblem } from "./package-errors.js";

const cancelled = (output) =>
  Object.assign(packageProblem("MCP_PACKAGE_CANCELLED", 409), output);

/**
 * Runs `file` like a promisified execFile, but as the leader of its own process group:
 * npm and uv start scripts, builds and compilers of their own. An abort (`signal`),
 * the timeout or output beyond `maxBuffer` sends SIGTERM to the whole group, SIGKILL
 * after `graceMs` and again once the leader closed. A run that ends by itself never
 * signals the group, so a reused group id is never hit. The one SIGKILL after the leader
 * of a *stopped* run closed is accepted: it reaches the group within moments of its end.
 *
 * Overlap: `server/features/tools/tool-installer.js` (`run`/`groupSignal`) and
 * `server/features/pipelines/native-owned-group.js` (`stopOwnedGroup`) use the same
 * detached-group pattern for their own processes; this runner keeps the execFile-like
 * result shape the MCP package installers read.
 */
export function runProcessTree(
  file,
  args,
  { cwd, env, timeout = 0, maxBuffer = 1024 * 1024, signal, graceMs = 5000 } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled({ stdout: "", stderr: "" }));
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return reject(Object.assign(error, { stdout: "", stderr: "" }));
    }
    let stdout = "";
    let stderr = "";
    let size = 0;
    let stopping = null;
    let timer;
    let grace;
    const killGroup = (name) => {
      // A spawn that failed has no pid: `-undefined` must never become a signal target.
      if (!(child.pid > 0)) return;
      try {
        process.kill(-child.pid, name);
      } catch {
        /* The group is gone already. */
      }
    };
    const stop = (reason) => {
      if (stopping) return;
      stopping = reason;
      killGroup("SIGTERM");
      grace = setTimeout(() => {
        killGroup("SIGKILL");
        // A descendant that left the group (setsid) may still hold the pipes open:
        // closing them lets `close` follow the leader's exit instead of waiting on it.
        child.stdout.destroy();
        child.stderr.destroy();
      }, graceMs);
    };
    const onAbort = () => stop("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeout > 0) timer = setTimeout(() => stop("timeout"), timeout);
    // Decoded per stream, so a multibyte character split across chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (append) => (text) => {
      size += Buffer.byteLength(text);
      if (size > maxBuffer) stop("maxBuffer");
      else append(text);
    };
    child.stdout.on(
      "data",
      collect((text) => (stdout += text)),
    );
    child.stderr.on(
      "data",
      collect((text) => (stderr += text)),
    );
    const settle = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      settle();
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.on("close", (code, killedBy) => {
      settle();
      // Stragglers of a stopped run (a build that ignores SIGTERM) go as well.
      if (stopping) killGroup("SIGKILL");
      if (stopping === "aborted") return reject(cancelled({ stdout, stderr }));
      if (code === 0 && !stopping) return resolve({ stdout, stderr });
      reject(
        Object.assign(
          new Error(`${path.basename(file)} exited with ${code ?? killedBy}`),
          {
            code,
            signal: killedBy,
            killed: !!stopping,
            stdout,
            stderr,
          },
        ),
      );
    });
  });
}
