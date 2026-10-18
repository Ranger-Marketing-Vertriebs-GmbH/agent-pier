import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Processes a test run left behind. Every process a run starts carries its marker
// (AGENTPIER_TEST_RUN=<id>, or the run's private TMPDIR) in its environment, also
// when it was reparented to init/launchd; nothing else on the host does.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function linuxProcesses() {
  const list = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const environ = fs.readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      const command = fs
        .readFileSync(`/proc/${name}/cmdline`, "utf8")
        .split("\0")
        .join(" ");
      let cwd = "";
      try {
        cwd = fs.readlinkSync(`/proc/${name}/cwd`);
      } catch {}
      list.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        command: command.trim(),
        text: [command, cwd, ...environ].join("\n"),
      });
    } catch {
      /* Gone meanwhile, or another user's. */
    }
  }
  return list;
}

function darwinProcesses() {
  // -E appends each own process's environment to its command.
  const result = spawnSync("ps", ["-axww", "-E", "-o", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, pgid, text]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      command: text.slice(0, 200),
      text,
    }));
}

/** The processes whose environment, command line or working folder names a marker. */
export function markedProcesses(markers) {
  const list = process.platform === "linux" ? linuxProcesses() : darwinProcesses();
  return list.filter(
    (entry) =>
      entry.pid !== process.pid && markers.some((marker) => entry.text.includes(marker)),
  );
}

/**
 * Stops what a run left behind: each leaked process group (SIGTERM, then SIGKILL
 * after a grace period), or the process alone when it shares the runner's group.
 * Returns the leaked processes as found.
 */
export function sweepRun(markers, { graceMs = 2000 } = {}) {
  // A process still shutting down cleanly gets a moment first.
  let leaked = markedProcesses(markers);
  if (leaked.length) {
    pause(500);
    leaked = markedProcesses(markers);
  }
  if (!leaked.length) return [];
  const signal = (name) => {
    const all = process.platform === "linux" ? linuxProcesses() : darwinProcesses();
    const marked = all.filter(
      (entry) =>
        entry.pid !== process.pid &&
        markers.some((marker) => entry.text.includes(marker)),
    );
    const ids = new Set(marked.map((entry) => entry.pid));
    // A whole group only when every member is the run's; never the runner's own.
    const owned = (pgid) =>
      pgid > 1 &&
      pgid !== process.pid &&
      all.every((entry) => entry.pgid !== pgid || ids.has(entry.pid));
    for (const entry of marked)
      try {
        if (owned(entry.pgid)) process.kill(-entry.pgid, name);
        else process.kill(entry.pid, name);
      } catch {
        /* Gone meanwhile. */
      }
  };
  signal("SIGTERM");
  for (let waited = 0; waited < graceMs && markedProcesses(markers).length; waited += 100)
    pause(100);
  signal("SIGKILL");
  return leaked;
}
