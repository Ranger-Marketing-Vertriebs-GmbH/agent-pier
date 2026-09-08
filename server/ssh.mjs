#!/usr/bin/env node
import path from "node:path";
import { problem } from "./lib/storage.js";
import { spawn } from "node:child_process";
import { SshAccessStore } from "./features/ssh/ssh-access-store.js";
import { SshSessions } from "./features/ssh/ssh-sessions.js";

// No shell interpolation or credentials in arguments. The supplied remote command
// follows normal OpenSSH semantics; this helper is not an OS isolation boundary.
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
  const invocation = grants.resolve(args[3], args[5]);
  const child = spawn(invocation.command, [...invocation.args, ...args.slice(7)], {
    stdio: "inherit",
    cwd: invocation.cwd,
  });
  child.once("error", () => {
    process.stderr.write("SSH konnte nicht gestartet werden.\n");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  // Only validated store errors may cross this boundary; filesystem diagnostics
  // are intentionally not printed (they may include local private paths).
  process.stderr.write(
    (error.status ? error.message : "SSH-Zugang konnte nicht verwendet werden.") + "\n",
  );
  process.exitCode = 1;
}
