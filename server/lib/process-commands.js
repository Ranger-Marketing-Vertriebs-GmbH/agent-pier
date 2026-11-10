import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * What every process of this host runs, one string per process: its command line and,
 * on Linux, the real path of its executable (/proc/<pid>/exe, which also names a
 * deleted file). macOS has no /proc, so `ps` lists the command lines there. Throws
 * when neither can be read.
 */
export function runningCommandLines({
  platform = process.platform,
  proc = "/proc",
} = {}) {
  if (platform === "linux") {
    let names = null;
    try {
      names = fs.readdirSync(proc).filter((name) => /^\d+$/.test(name));
    } catch {}
    if (names) {
      const lines = [];
      for (const pid of names) {
        const parts = [];
        try {
          parts.push(
            fs
              .readFileSync(path.join(proc, pid, "cmdline"), "utf8")
              .replaceAll("\0", " "),
          );
        } catch {}
        try {
          parts.push(fs.readlinkSync(path.join(proc, pid, "exe")));
        } catch {}
        if (parts.length) lines.push(parts.join(" "));
      }
      return lines;
    }
  }
  return execFileSync("ps", ["-A", "-ww", "-o", "command="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  }).split("\n");
}

/**
 * A test `held(paths)`: whether a running process names one of `paths` (folders) or a
 * path inside them. The process list is read once, on the first question; when it
 * cannot be read every folder counts as held, so nothing a process may run is removed.
 */
export function heldPaths(read = runningCommandLines) {
  let lines;
  return (paths) => {
    if (lines === undefined) {
      try {
        lines = read();
      } catch {
        lines = null;
      }
    }
    if (lines === null) return true;
    const folders = paths.filter(Boolean).map((item) => item.replace(/\/+$/, ""));
    return lines.some((line) =>
      folders.some((folder) => line.includes(`${folder}/`) || line.endsWith(folder)),
    );
  };
}
