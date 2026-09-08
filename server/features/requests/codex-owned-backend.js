import { spawn } from "node:child_process";

// Keep the detached group leader alive until its owner finishes group cleanup.
// An IPC disconnect also closes the group if the launch wrapper is killed abruptly.
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.on("disconnect", () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(1);
  }
});
process.once("message", ({ command, args, cwd }) => {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  let reported = false;
  const report = (code) => {
    if (reported) return;
    reported = true;
    if (process.connected) process.send({ type: "backend-exit", code });
  };
  child.once("error", () => report(127));
  // Descendants can inherit pipes; the native child's exit must still start cleanup.
  child.once("exit", (code) => report(code ?? 1));
});
