import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/*
 * The working directories of this user's processes, so a cleanup can see a command
 * (a background build, a dev server) still running inside a folder. Linux reads
 * /proc/<pid>/cwd; macOS asks lsof once for every process's cwd. A failed read
 * throws: the caller then refuses instead of guessing.
 */
async function linuxCwds() {
  const cwds = [];
  for (const name of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      cwds.push(await fs.readlink(`/proc/${name}/cwd`));
    } catch {
      // Another user's process, or one that ended meanwhile.
    }
  }
  return cwds;
}
async function macCwds() {
  const uid = process.getuid?.();
  let stdout;
  try {
    ({ stdout } = await run(
      "/usr/sbin/lsof",
      ["-a", "-d", "cwd", "-u", String(uid), "-Fn", "-w"],
      { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    // lsof exits 1 when one of many processes could not be read; its list still counts.
    if (typeof error.stdout !== "string" || !error.stdout) throw error;
    stdout = error.stdout;
  }
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("n/"))
    .map((line) => line.slice(1));
}
export function processCwds() {
  return process.platform === "linux" ? linuxCwds() : macCwds();
}
/** Whether any process works inside `folder` (a real path). */
export function anyInside(cwds, folder) {
  return cwds.some((cwd) => cwd === folder || cwd.startsWith(folder + path.sep));
}
