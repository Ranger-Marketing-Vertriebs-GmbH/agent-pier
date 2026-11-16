import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const TIMEOUT_MS = 5000;

// /proc/self/mountinfo writes space, tab, newline and backslash as octal escapes.
const unescapeMountinfo = (value) =>
  value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

/** The mount points of Linux's /proc/self/mountinfo (the fifth field of each line). */
export function parseMountinfo(text) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const point = line.split(" ")[4];
      if (!point?.startsWith("/")) throw new Error("unreadable mountinfo line");
      return unescapeMountinfo(point);
    });
}

/**
 * The mount points of macOS `mount` output, lines such as
 * `/dev/disk3s1 on /Volumes/Data (apfs, local, journaled)`. A line that does not
 * read that way (a mount point with a newline in it) makes the whole table
 * unreadable rather than hide a mount.
 */
export function parseMountOutput(text) {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^.*? on (\/.*) \([^()]*\)$/.exec(line);
      if (!match) throw new Error("unreadable mount line");
      return match[1];
    });
}

// macOS lists the data volume's mounts under its firmlink root as well.
const DATA_ROOT = "/System/Volumes/Data";

/**
 * Every mount point of this system, each also as the path a folder reads (macOS
 * firmlinks). Bounded in time; throws when the table cannot be read, so a caller
 * refuses rather than assume no mount.
 */
export async function readMountPoints({
  platform = process.platform,
  run = runMount,
  read = (file) => readFile(file, "utf8"),
} = {}) {
  if (platform === "linux") return parseMountinfo(await read("/proc/self/mountinfo"));
  if (platform !== "darwin") throw new Error("no mount table on this platform");
  const points = parseMountOutput(await run());
  return [
    ...points,
    ...points
      .filter((point) => point.startsWith(`${DATA_ROOT}/`))
      .map((point) => point.slice(DATA_ROOT.length)),
  ];
}

function runMount() {
  return new Promise((resolve, reject) =>
    execFile(
      "/sbin/mount",
      [],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
