import { spawn } from "node:child_process";
import { problem } from "../../lib/storage.js";
import { runInteractiveSsh } from "./ssh-interactive-run.js";

/** Combined stdout and stderr bytes one remote command may return. */
export const sshOutputLimit = 65536;

/** The 502 problem of an SSH program that cannot start (agents read it). */
export const sshCannotStart = () => problem("SSH command could not start.", 502);

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
 * The hard timeout and the authorization check every `intervalMs` of one SSH child:
 * either kills it with SIGKILL and sets `timedOut` or `revoked` on the returned state.
 * `stop()` ends both once the child closed.
 */
export function superviseSsh(
  child,
  { timeoutMs, stillAuthorized = () => true, intervalMs = 250 },
) {
  const state = { timedOut: false, revoked: false, ended: false };
  let checking = false;
  const timeout = setTimeout(() => {
    state.timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const authorization = setInterval(async () => {
    if (checking || state.ended) return;
    checking = true;
    try {
      if (!(await stillAuthorized())) throw Error();
    } catch {
      if (!state.ended) {
        state.revoked = true;
        child.kill("SIGKILL");
      }
    } finally {
      checking = false;
    }
  }, intervalMs);
  state.stop = () => {
    state.ended = true;
    clearTimeout(timeout);
    clearInterval(authorization);
  };
  return state;
}

/**
 * Runs one command through a prepared OpenSSH invocation (SshAccessStore.connection):
 * no shell, 64 KiB of combined output, a hard timeout, and an authorization check
 * every `intervalMs` that kills the command once it fails or throws. Resolves with
 * what ran; rejects with a 502 problem when the program cannot start. A host in
 * interactive shell mode runs the command through its console instead
 * (ssh-interactive-run.js).
 */
export function runSshCommand(connection, command, options) {
  if (connection.interactive) return runInteractiveSsh(connection, command, options);
  const { onSpawn = () => {} } = options;
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
      truncated = false;
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
    const watch = superviseSsh(child, options);
    child.once("error", () => {
      watch.stop();
      reject(sshCannotStart());
    });
    child.once("close", (exitCode, signal) => {
      watch.stop();
      const output = decodeOutput(stdout, sshOutputLimit);
      resolve({
        stdout: output,
        stderr: decodeOutput(stderr, sshOutputLimit - Buffer.byteLength(output)),
        exitCode,
        signal,
        truncated,
        timedOut: watch.timedOut,
        revoked: watch.revoked,
        durationMs: Date.now() - started,
      });
    });
  });
}
