import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const read = (command, args, env) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 65536,
    ...(env && { env: { ...process.env, ...env } }),
  }).trim();

// Linux reports a rewritten process title instead of argv, so /proc's executable
// link is the evidence there. macOS ps reports the full comm of an untitled process.
export function processExecutable(pid) {
  return process.platform === "linux"
    ? fs.readlinkSync(`/proc/${pid}/exe`)
    : read("ps", ["-ww", "-p", String(pid), "-o", "comm="]);
}

// Both platforms show process.title (for example "openclaw-gateway") in ps. On macOS
// the mapped executable image remains the authoritative path behind such a title.
function processImage(pid) {
  const executable = processExecutable(pid);
  if (process.platform === "linux" || path.isAbsolute(executable)) return executable;
  const image = read("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"])
    .split("\n")
    .find((line) => line.startsWith("n/"));
  if (!image) throw Error("Process executable unavailable.");
  return image.slice(1);
}

function processStartTime(pid) {
  if (process.platform !== "linux")
    return read("ps", ["-p", String(pid), "-o", "lstart="], { LC_ALL: "C", TZ: "UTC" });
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // Fields after the parenthesized comm; starttime is field 22 overall.
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function processCommand(pid) {
  if (process.platform !== "linux")
    return read("ps", ["-ww", "-p", String(pid), "-o", "command="]);
  return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
}

/** Throws when any part of the identity cannot be observed. */
export function processIdentity(pid) {
  const startTime = processStartTime(pid);
  if (!startTime) throw Error("Process start time unavailable.");
  return {
    startTime,
    executable: fs.realpathSync(processImage(pid)),
    command: processCommand(pid),
  };
}

/** This boot's identity; it changes with every restart of the host. */
export function bootIdentity() {
  const boot =
    process.platform === "linux"
      ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      : read("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
  if (!boot) throw Error("Boot identity unavailable.");
  return boot;
}

/** The pids of every process in process group `pgid`. */
export function processGroupMembers(pgid) {
  return read("ps", ["-A", "-o", "pid=,pgid="])
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid > 0)
    .map(([pid]) => pid);
}

/**
 * Whether start time `later` (processIdentity().startTime of this boot) is at or
 * after `earlier`: clock ticks since boot on Linux, a UTC date elsewhere.
 */
export function startedAtOrAfter(later, earlier) {
  const value = (time) => (/^\d+$/.test(time) ? Number(time) : Date.parse(`${time} UTC`));
  const [a, b] = [value(later), value(earlier)];
  return Number.isFinite(a) && Number.isFinite(b) && a >= b;
}
