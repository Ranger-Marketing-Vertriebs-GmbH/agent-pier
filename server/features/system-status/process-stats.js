import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
// One ps call per refresh covers every process; a host with more is not walked.
export const MAX_PROCESSES = 20000;
// Linux reports CPU time in clock ticks; every supported kernel build uses 100 Hz.
const LINUX_TICKS = 100;

/** CPU time from ps: Linux "[DD-]HH:MM:SS", macOS "MMM:SS.cc". */
export function cpuSeconds(text) {
  const match = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(String(text).trim());
  if (!match) return null;
  const parts = match[2].split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds + Number(match[1] || 0) * 86400;
}

/** Parses `ps -A -o pid=,ppid=,rss=,%cpu=,time=` into a map by pid. */
export function parseProcessTable(stdout) {
  const table = new Map();
  for (const line of String(stdout).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    table.set(pid, {
      pid,
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4].replace(",", ".")) || 0,
      cpuSeconds: cpuSeconds(match[5]),
    });
    if (table.size >= MAX_PROCESSES) break;
  }
  return table;
}

/** utime + stime from /proc/<pid>/stat; the comm field may contain spaces. */
export function linuxStatSeconds(stat) {
  const fields = String(stat)
    .slice(String(stat).lastIndexOf(")") + 2)
    .split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]);
  return Number.isFinite(ticks) ? ticks / LINUX_TICKS : null;
}

export async function readProcessTable({
  run = exec,
  read = readFile,
  platform = process.platform,
  pids,
} = {}) {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,%cpu=,time="], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  const table = parseProcessTable(stdout);
  // ps on Linux rounds CPU time to whole seconds; /proc keeps 10 ms resolution.
  if (platform === "linux" && pids)
    await Promise.all(
      [...pids(table)].map(async (pid) => {
        const entry = table.get(pid);
        try {
          const seconds = linuxStatSeconds(await read(`/proc/${pid}/stat`, "utf8"));
          if (entry && seconds !== null) entry.cpuSeconds = seconds;
        } catch {
          // A process that exited since ps keeps the coarser ps value.
        }
      }),
    );
  return table;
}

function childrenOf(table) {
  const children = new Map();
  for (const entry of table.values()) {
    if (entry.pid === entry.ppid) continue;
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry.pid);
  }
  return children;
}

/**
 * Every pid in each root's tree. A pid belongs to the first root that reaches it, so
 * listing the Gateway and sessions before the server keeps their trees apart.
 */
export function processTrees(table, roots) {
  const children = childrenOf(table);
  const claimed = new Set();
  const trees = new Map();
  for (const [key, root] of roots) {
    const tree = new Set();
    const stack = Number.isSafeInteger(root) && table.has(root) ? [root] : [];
    while (stack.length && tree.size < MAX_PROCESSES) {
      const pid = stack.pop();
      if (claimed.has(pid)) continue;
      claimed.add(pid);
      tree.add(pid);
      for (const child of children.get(pid) || []) stack.push(child);
    }
    trees.set(key, tree);
  }
  return trees;
}

/**
 * RSS and CPU of one process tree. CPU is the share of one core since the previous
 * sample, from the CPU time delta; a process without a previous value uses ps %cpu.
 */
export function treeUsage(table, pids, previous, elapsedMs) {
  let rssBytes = 0,
    cpuPercent = 0;
  for (const pid of pids) {
    const entry = table.get(pid);
    if (!entry) continue;
    rssBytes += entry.rssBytes;
    const before = previous?.get(pid);
    if (
      elapsedMs > 0 &&
      before?.cpuSeconds != null &&
      entry.cpuSeconds != null &&
      entry.cpuSeconds >= before.cpuSeconds
    )
      cpuPercent += ((entry.cpuSeconds - before.cpuSeconds) * 100000) / elapsedMs;
    else cpuPercent += entry.cpuPercent;
  }
  return { processes: pids.size, rssBytes, cpuPercent: Math.round(cpuPercent * 10) / 10 };
}
