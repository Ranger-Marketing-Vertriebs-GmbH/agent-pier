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
