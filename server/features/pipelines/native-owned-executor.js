import { spawn } from "node:child_process";

/** Keep the group leader alive until its parent has killed the exact group it created. */
export function runOwnedCommand({ command, args, cwd, env, input }) {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("message", () => {});
  process.on("disconnect", () => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: [typeof input === "string" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  if (typeof input === "string") {
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  let reported = false;
  const report = (exitCode, signal) => {
    if (reported) return;
    reported = true;
    if (process.connected) process.send({ exitCode, signal });
  };
  child.on("error", () => report(127, null));
  // Inherited child pipes may remain open in grandchildren. Exit starts group cleanup immediately.
  child.on("exit", (code, signal) => report(code, signal));
}
