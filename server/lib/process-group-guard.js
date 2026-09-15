import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Called only by a detached group leader, before starting native work. */
export function guardProcessGroup() {
  const stop = () => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("message", () => {});
  process.on("disconnect", stop);
  if (!process.connected) stop();

  // This child stays in our group and pins its identity even if we are killed.
  const guard = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./process-group-watchdog.js", import.meta.url)),
      String(process.pid),
    ],
    { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  guard.on("error", stop);
  guard.on("exit", stop);
  guard.on("disconnect", stop);
  return new Promise((resolve) => {
    guard.once("message", (message) => {
      if (message === "ready") resolve();
      else stop();
    });
  });
}
