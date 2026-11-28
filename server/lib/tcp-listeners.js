import { execFileSync } from "node:child_process";

const read = (command, args) =>
  execFileSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 2 ** 20,
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * The TCP sockets processes listen on, `[{ pid, address, port }]`: all of them, or
 * those on `port`. Read with `ss` on Linux and `lsof` on macOS. Throws when that
 * program is missing or fails; a listener of another account may be missing from
 * the answer, because the system names only the processes the caller may inspect.
 * So an empty answer never proves that a port is free, only that its listener is
 * not known.
 */
export function tcpListeners({ port } = {}) {
  let rows;
  if (process.platform === "linux")
    rows = read("ss", ["-H", "-ltnp", ...(port ? ["sport", "=", `:${port}`] : [])])
      .split("\n")
      .flatMap((line) => {
        const local = line.trim().split(/\s+/)[3] || "";
        return [...line.matchAll(/pid=(\d+)/g)].map((match) => ({
          pid: Number(match[1]),
          local,
        }));
      });
  else {
    let listing = "";
    try {
      listing = read("/usr/sbin/lsof", [
        "-nP",
        port ? `-iTCP:${port}` : "-iTCP",
        "-sTCP:LISTEN",
      ]);
    } catch (error) {
      // lsof exits 1 when nothing matches, and says nothing then.
      if (error.status !== 1 || error.stdout) throw error;
    }
    rows = listing
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => columns.length >= 9)
      .map((columns) => ({ pid: Number(columns[1]), local: columns.at(-2) }));
  }
  return rows.map(({ pid, local }) => ({
    pid,
    address: local.slice(0, local.lastIndexOf(":")).replace(/^\[|\]$/g, ""),
    port: Number(local.slice(local.lastIndexOf(":") + 1)),
  }));
}
