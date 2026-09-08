import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopOwnedGroup } from "./native-owned-group.js";

export function spawnNativeProcess(payload) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./native-group-entry.js", import.meta.url))],
    {
      cwd: payload.cwd,
      env: payload.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let result;
  child.on("message", (message) => {
    result = message;
    stopOwnedGroup(child);
  });
  child.once("spawn", () =>
    child.send({
      command: payload.command,
      args: payload.args,
      cwd: payload.cwd,
      env: payload.env,
      input: payload.initialInput,
    }),
  );
  return { child, stop: () => stopOwnedGroup(child), outcome: () => result };
}
