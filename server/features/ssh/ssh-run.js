import { spawn } from "node:child_process";
import { problem } from "../../lib/storage.js";

/** Combined stdout and stderr bytes one remote command may return. */
export const sshOutputLimit = 65536;

/** Decodes at most `budget` bytes without splitting a UTF-8 character. */
export function decodeOutput(buffer, budget) {
  let text = "",
    bytes = 0;
  for (const character of buffer.toString("utf8")) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    text += character;
    bytes += size;
  }
  return text;
}

/**
 * Runs one command through a prepared OpenSSH invocation (SshAccessStore.connection):
 * no shell, 64 KiB of combined output, a hard timeout, and an authorization check
 * every `intervalMs` that kills the command once it fails or throws. Resolves with
 * what ran; rejects with a 502 problem when the program cannot start.
 */
export function runSshCommand(
  connection,
  command,
  { timeoutMs, stillAuthorized = () => true, onSpawn = () => {}, intervalMs = 250 },
) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(connection.command, [...connection.args, command], {
      cwd: connection.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn(child);
    let stdout = Buffer.alloc(0),
      stderr = Buffer.alloc(0),
      truncated = false,
      timedOut = false,
      revoked = false,
      checking = false,
      ended = false;
    const append = (which, chunk) => {
      const available = sshOutputLimit - stdout.length - stderr.length;
      const kept = chunk.subarray(0, Math.max(0, available));
      if (which === "stdout") stdout = Buffer.concat([stdout, kept]);
      else stderr = Buffer.concat([stderr, kept]);
      if (chunk.length > available) {
        truncated = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const authorization = setInterval(async () => {
      if (checking || ended) return;
      checking = true;
      try {
        if (!(await stillAuthorized())) throw Error();
      } catch {
        if (!ended) {
          revoked = true;
          child.kill("SIGKILL");
        }
      } finally {
        checking = false;
      }
    }, intervalMs);
    const clean = () => {
      ended = true;
      clearTimeout(timeout);
      clearInterval(authorization);
    };
    child.once("error", () => {
      clean();
      reject(problem("SSH command could not start.", 502));
    });
    child.once("close", (exitCode, signal) => {
      clean();
      const output = decodeOutput(stdout, sshOutputLimit);
      resolve({
        stdout: output,
        stderr: decodeOutput(stderr, sshOutputLimit - Buffer.byteLength(output)),
        exitCode,
        signal,
        truncated,
        timedOut,
        revoked,
        durationMs: Date.now() - started,
      });
    });
  });
}
