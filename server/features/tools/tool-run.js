import { spawn } from "node:child_process";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

function groupSignal(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}
/**
 * Runs an installer step in its own process group: no shell, a timeout, abort on
 * shutdown, and the last 16 KiB of output for the error.
 */
export function run(command, args, env, cwd, signal, timeout) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(problem(serverMessages.tools.installationAborted, 409));
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "",
      reason = null,
      killTimer;
    const capture = (data) => {
      output = (output + data).slice(-16384);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const stop = (message) => {
      if (reason) return;
      reason = message;
      groupSignal(child, "SIGTERM");
      killTimer = setTimeout(() => groupSignal(child, "SIGKILL"), 500);
    };
    const abort = () => stop(serverMessages.tools.installationShutdown);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(serverMessages.tools.installationTimeout),
      timeout,
    );
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      groupSignal(child, "SIGKILL");
    };
    child.on("error", () => {
      finish();
      reject(problem(serverMessages.tools.installerUnavailable, 409));
    });
    child.on("close", (code) => {
      finish();
      if (reason) return reject(problem(reason, 409));
      if (code !== 0) {
        const hint = output.match(
          /\b(EACCES|ENOSPC|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|EBADENGINE)\b/,
        )?.[1];
        return reject(
          problem(
            hint
              ? serverMessages.tools.installationExitFailureWithHint(code, hint)
              : serverMessages.tools.installationExitFailure(code),
            409,
          ),
        );
      }
      resolve(output);
    });
  });
}
