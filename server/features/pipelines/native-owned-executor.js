import { spawn } from "node:child_process";
import { guardProcessGroup } from "../../lib/process-group-guard.js";

/** Keep the group leader alive until its parent has killed the exact group it created. */
export async function runOwnedCommand({ command, args, cwd, env, input }) {
  await guardProcessGroup();
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
