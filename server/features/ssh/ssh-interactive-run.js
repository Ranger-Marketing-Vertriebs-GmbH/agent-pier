import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { decodeOutput, sshCannotStart, sshOutputLimit, superviseSsh } from "./ssh-run.js";
import {
  consoleText,
  lastLine,
  pagerPattern,
  promptPattern,
  withoutEcho,
} from "./ssh-console-text.js";

/**
 * How long the console waits: `idleMs` of silence counts as "ready" (a prompt the
 * heuristics do not know, a password question), `settleMs` of silence after a
 * recognised prompt confirms it.
 */
export const interactiveTiming = { idleMs: 1500, settleMs: 250 };

const notStarted =
  "Interactive shell: the connection ended before the device showed a prompt; no command was sent.";

/** The lines a command sends, one per line; trailing blank lines are left out. */
export function commandLines(command) {
  const lines = String(command).split(/\r?\n/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines;
}

/**
 * Runs `command` through the console of a host in interactive shell mode
 * (docs/ssh-access.md): the connection (OpenSSH with `-tt`, no remote command)
 * opens the device's shell; after its first prompt each line of the command is
 * typed, and the next line waits for the prompt (or `idleMs` of silence) again.
 * Pager prompts get a space. Then `exit` is typed if the console shows a prompt,
 * and the connection is closed.
 * The result has the same shape as runSshCommand's: `stdout` is the console text
 * without control sequences or the echoed lines, `exitCode` is null (a console
 * reports none) unless the connection failed before the first prompt, and
 * `interactive: true` marks the mode. Nothing is written to disk.
 */
export function runInteractiveSsh(connection, command, options) {
  const { onSpawn = () => {}, timing = interactiveTiming } = options;
  const lines = commandLines(command);
  const began = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(connection.command, connection.args, {
      cwd: connection.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onSpawn(child);
    child.stdin.on("error", () => {});
    const out = new StringDecoder("utf8"),
      err = new StringDecoder("utf8");
    // segments[0]: banner and first prompt; segments[n]: what followed the n-th line.
    const segments = [""];
    let stderr = "",
      bytes = 0,
      truncated = false,
      started = false,
      exiting = false,
      closedByUs = false,
      atPrompt = false,
      pagerFrom = 0,
      timer = null;
    const budget = (chunk) => {
      const available = sshOutputLimit - bytes;
      bytes += chunk.length;
      if (chunk.length <= available) return chunk;
      truncated = true;
      child.kill("SIGKILL");
      return chunk.subarray(0, Math.max(0, available));
    };
    const type = (text) => {
      if (child.stdin.writable) child.stdin.write(text);
    };
    const wait = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(ready, ms);
    };
    const hangUp = () => {
      closedByUs = true;
      child.stdin.end();
      child.kill("SIGTERM");
    };
    // The console waits for input: type the next line, `exit`, or hang up. `exit`
    // is typed only at a recognised prompt, never as the answer to a question
    // (`[confirm]`, a file name) the last line left open.
    function ready() {
      timer = null;
      if (exiting) return hangUp();
      started = true;
      const sent = segments.length - 1;
      if (sent < lines.length) type(`${lines[sent]}\n`);
      else if (!atPrompt) return hangUp();
      else {
        type("exit\n");
        exiting = true;
      }
      segments.push("");
      pagerFrom = 0;
      atPrompt = false;
      wait(timing.idleMs);
    }
    child.stdout.on("data", (chunk) => {
      const step = segments.length - 1;
      segments[step] += out.write(budget(chunk));
      if (truncated) return;
      const current = segments[step];
      const line = lastLine(current.slice(pagerFrom));
      atPrompt = false;
      if (pagerPattern.test(line)) {
        type(" ");
        pagerFrom = current.length;
        return wait(timing.idleMs);
      }
      // After a line was typed, its echo ends with a line break before any prompt.
      atPrompt = promptPattern.test(line) && (step === 0 || /\n/.test(current));
      wait(atPrompt ? timing.settleMs : timing.idleMs);
    });
    child.stderr.on("data", (chunk) => {
      stderr += err.write(budget(chunk));
    });
    const watch = superviseSsh(child, options);
    child.once("error", () => {
      clearTimeout(timer);
      watch.stop();
      reject(sshCannotStart());
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      watch.stop();
      segments[segments.length - 1] += out.end();
      stderr += err.end();
      let text = "";
      segments.forEach((segment, index) => {
        const sent = index === 0 ? "" : (lines[index - 1] ?? "exit");
        const part = withoutEcho(consoleText(segment), sent);
        if (!part) return;
        text +=
          (text && !text.endsWith("\n") && !part.startsWith("\n") ? "\n" : "") + part;
      });
      text = text.replace(/^\n+/, "").trimEnd();
      if (text) text += "\n";
      stderr = stderr.replace(/\r+\n/g, "\n");
      if (!started && !watch.timedOut && !watch.revoked && !truncated)
        stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${notStarted}\n`;
      const output = decodeOutput(Buffer.from(text), sshOutputLimit);
      resolve({
        stdout: output,
        stderr: decodeOutput(
          Buffer.from(stderr),
          Math.max(0, sshOutputLimit - Buffer.byteLength(output)),
        ),
        // A console has no exit status; before its first prompt the connection's
        // own status (255 for OpenSSH errors) says why nothing ran.
        exitCode: started ? null : exitCode,
        signal: closedByUs ? null : signal,
        truncated,
        timedOut: watch.timedOut,
        revoked: watch.revoked,
        durationMs: Date.now() - began,
        interactive: true,
        started,
      });
    });
  });
}
