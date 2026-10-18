import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Summed idle and total CPU time over every core, from os.cpus(). */
export function cpuTimes(cpus) {
  let idle = 0,
    total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Busy share of all cores between two cpuTimes() readings, 0–100. */
export function cpuBusy(before, after) {
  if (!before || !after) return null;
  const total = after.total - before.total;
  if (total <= 0) return null;
  const busy = 1 - (after.idle - before.idle) / total;
  return Math.round(Math.min(1, Math.max(0, busy)) * 1000) / 10;
}

/** vm_stat's page size and its "Pages …" counters, keyed by their label. */
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]) || 4096;
  const pages = {};
  for (const line of String(text).split("\n")) {
    const match = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (match) pages[match[1].trim().toLowerCase()] = Number(match[2]);
  }
  return { pageSize, pages };
}

/**
 * Used memory as Activity Monitor counts it: app memory (anonymous pages without
 * purgeable ones), wired memory and the compressor. File cache and free pages count
 * as available, because macOS hands them back on demand; os.freemem() reports only
 * the free pages and would show a busy Mac as almost full.
 */
export function macMemoryUsed({ pageSize, pages }, totalBytes) {
  const anonymous = pages["anonymous pages"];
  if (anonymous === undefined) {
    const available =
      ((pages["pages free"] || 0) +
        (pages["pages inactive"] || 0) +
        (pages["pages speculative"] || 0)) *
      pageSize;
    return Math.max(0, totalBytes - available);
  }
  const used =
    (anonymous -
      (pages["pages purgeable"] || 0) +
      (pages["pages wired down"] || 0) +
      (pages["pages occupied by compressor"] || 0)) *
    pageSize;
  return Math.min(totalBytes, Math.max(0, used));
}

/** Total and used memory. Linux os.freemem() already reads MemAvailable. */
export async function memoryStats({
  platform = process.platform,
  run = exec,
  totalmem = os.totalmem,
  freemem = os.freemem,
} = {}) {
  const totalBytes = totalmem();
  let usedBytes = totalBytes - freemem();
  if (platform === "darwin") {
    try {
      const { stdout } = await run("vm_stat", [], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 65536,
        env: { ...process.env, LC_ALL: "C" },
      });
      usedBytes = macMemoryUsed(parseVmStat(stdout), totalBytes);
    } catch {
      // Without vm_stat the free-page count is the only figure left.
    }
  }
  return { totalBytes, usedBytes };
}

/**
 * Disk figures of the volume holding `directory`. "Free" is what an unprivileged
 * process may still write (bavail); everything else counts as used.
 */
export function diskFromStatfs(stats) {
  const block = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * block;
  const freeBytes = Number(stats.bavail) * block;
  return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

export async function diskStats(directory, read = statfs) {
  return diskFromStatfs(await read(directory));
}
