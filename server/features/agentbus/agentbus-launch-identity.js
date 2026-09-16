import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

/** Resolve only the Node shebang used by installed JavaScript CLI entrypoints. */
export function resolveAgentBusInterpreter(command, env = {}) {
  let fd;
  try {
    fd = openSync(command, "r");
    const bytes = Buffer.alloc(512);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const line = bytes.subarray(0, count).toString("utf8").split("\n", 1)[0].trim();
    const match = /^#!\s*(\/\S+)(?:\s+(node))?$/.exec(line);
    if (!match) return null;
    const interpreter =
      match[2] === "node" && match[1] === "/usr/bin/env"
        ? (env.PATH || "")
            .split(path.delimiter)
            .filter(path.isAbsolute)
            .map((dir) => path.join(dir, "node"))
        : !match[2] && path.basename(match[1]) === "node"
          ? [match[1]]
          : [];
    for (const candidate of interpreter) {
      try {
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {}
    }
  } catch {
    // Missing or unsupported launchers never authorize an arbitrary interpreter.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}
