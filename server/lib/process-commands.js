import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * What every process of this host runs, one string per process: its command line,
 * its environment where this user may read it, and on Linux the real path of its
 * executable (/proc/<pid>/exe, which also names a deleted file). The environment
 * counts because a server may name a folder only there (REA's GHIDRA_INSTALL_DIR and
 * JAVA_HOME, Craft Anything's CRAFT_ANYTHING_CONFIG_DIR). macOS has no /proc, so
 * `ps -E` lists command lines with environments there. Throws when neither can be
 * read.
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
      const read = (pid, file) =>
        fs.readFileSync(path.join(proc, pid, file), "utf8").replaceAll("\0", " ");
      for (const pid of names) {
        const parts = [];
        for (const file of ["cmdline", "environ"])
          try {
            parts.push(read(pid, file));
          } catch {}
        try {
          parts.push(fs.readlinkSync(path.join(proc, pid, "exe")));
        } catch {}
        if (parts.length) lines.push(parts.join(" "));
      }
      return lines;
    }
  }
  const args =
    platform === "darwin"
      ? ["-A", "-ww", "-E", "-o", "command="]
      : ["-A", "-ww", "-o", "command="];
  return execFileSync("ps", args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n");
}

// A snapshot answers the questions of one prune; a later prune reads the list again.
const snapshotMs = 2000;

/**
 * A test `held(paths, id)`: whether a running process names one of `paths` (folders)
 * or a path inside them. `also(id, lines)` may hold a component's folders for another
 * reason (a server that read their paths from a config file at its start). The process
 * list is read on the first question and again once it is a few seconds old; when it
 * cannot be read every folder counts as held, so nothing a process may run is removed.
 */
export function heldPaths(read = runningCommandLines, { also = null } = {}) {
  let lines;
  let readAt = 0;
  return (paths, id) => {
    if (lines === undefined || Date.now() - readAt > snapshotMs) {
      readAt = Date.now();
      try {
        lines = read();
      } catch {
        lines = null;
      }
    }
    if (lines === null) return true;
    if (also?.(id, lines)) return true;
    const folders = paths.filter(Boolean).map((item) => item.replace(/\/+$/, ""));
    return lines.some((line) =>
      folders.some(
        (folder) =>
          line.includes(`${folder}/`) ||
          line.includes(`${folder} `) ||
          line.endsWith(folder),
      ),
    );
  };
}
