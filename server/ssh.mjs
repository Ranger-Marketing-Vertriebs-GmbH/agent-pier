#!/usr/bin/env node
import path from "node:path";
import { problem } from "./lib/storage.js";
import { agentText } from "./lib/i18n/agent-text.js";
import { spawn } from "node:child_process";
import { SshAccessStore } from "./features/ssh/ssh-access-store.js";
import { SshSessions } from "./features/ssh/ssh-sessions.js";
import { runSshCommand } from "./features/ssh/ssh-run.js";

// No shell interpolation or credentials in arguments. The supplied remote command
// follows normal OpenSSH semantics; this helper is not an OS isolation boundary.
// Coding agents read its stderr, so every message is English.
try {
  const args = process.argv.slice(2);
  if (
    args[0] !== "--data-dir" ||
    !path.isAbsolute(args[1] || "") ||
    args[2] !== "--session" ||
    args[4] !== "--access" ||
    !args[5] ||
    (args.length > 6 && args[6] !== "--")
  )
    throw problem(
      "Usage: ssh.mjs --data-dir DIR --session ID --access ID [-- remote command]",
    );
  const dataDir = args[1];
  const store = new SshAccessStore({ dataDir });
  const grants = new SshSessions({ dataDir, store });
  const invocation = await grants.resolve(args[3], args[5]);
  try {
    if (store.revision(args[5]) !== invocation.revision)
      throw problem("SSH access changed. Please try again.", 409);
    const command = args.slice(7);
    if (invocation.interactive && command.length) {
      // A console-only device: type the command into its shell (ssh-interactive-run.js).
      const result = await runSshCommand(invocation, command.join(" "), {
        timeoutMs: 120000,
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode ?? (result.timedOut || result.signal ? 1 : 0);
    } else
      await new Promise((resolve) => {
        const child = spawn(invocation.command, [...invocation.args, ...command], {
          stdio: "inherit",
          cwd: invocation.cwd,
        });
        child.once("error", () => {
          process.stderr.write("SSH could not be started.\n");
          process.exitCode = 1;
          resolve();
        });
        child.once("exit", (code) => {
          process.exitCode = code ?? 1;
          resolve();
        });
      });
  } finally {
    invocation.cleanup?.();
  }
} catch (error) {
  // Only validated store errors may cross this boundary; filesystem diagnostics
  // are intentionally not printed (they may include local private paths).
  process.stderr.write(
    (error.status ? agentText(error.message) : "SSH access could not be used.") + "\n",
  );
  process.exitCode = 1;
}
