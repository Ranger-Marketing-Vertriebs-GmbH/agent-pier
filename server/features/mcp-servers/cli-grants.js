import fs from "node:fs";
import path from "node:path";
import { resolveCommand } from "./command-resolution.js";

// A `#!` line is short; anything longer is not read.
const headBytes = 256;

/**
 * The first bytes of `file`, only when it is a regular file: a FIFO or a device would
 * block the session start. O_NONBLOCK also covers a file swapped after the check.
 */
function head(file) {
  if (!fs.statSync(file).isFile()) return "";
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) return "";
    const buffer = Buffer.alloc(headBytes);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, headBytes, 0)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The programs a script's `#!` line starts: the interpreter, and for
 * `#!/usr/bin/env name` also `name` resolved on `pathEnv`. None for a binary.
 */
export function interpreters(file, { pathEnv = "", readHead = head, exists } = {}) {
  let first;
  try {
    first = readHead(file).split("\n", 1)[0];
  } catch {
    return [];
  }
  if (!first.startsWith("#!")) return [];
  const [program, ...rest] = first.slice(2).trim().split(/\s+/);
  if (!program || !path.isAbsolute(program)) return [];
  if (path.basename(program) !== "env") return [program];
  const name = rest.find((part) => !part.startsWith("-"));
  if (!name) return [program];
  try {
    return [program, resolveCommand(name, { pathEnv, ...(exists ? { exists } : {}) })];
  } catch {
    return [program];
  }
}

/**
 * nono grants for bound stdio servers (docs/sandbox.md): read for the command, the
 * file it links to and its interpreters; full access to its working directory, unless
 * that directory is too broad: `/`, the owner's `home` or the AgentPier `dataDir` or
 * an ancestor of either, or anything inside `dataDir` (real paths compared). Such a
 * cwd gets no grant and a code-only warning;
 * the server may then fail under nono. Remote servers need none.
 */
export function stdioGrants(
  definitions,
  {
    pathEnv = "",
    readHead = head,
    realpath = fs.realpathSync,
    exists,
    home = null,
    dataDir = null,
    warn = () => {},
  } = {},
) {
  const real = (file) => {
    try {
      return realpath(file);
    } catch {
      return path.resolve(file);
    }
  };
  const within = (child, parent) =>
    child === parent ||
    child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const guarded = [home, dataDir].filter(Boolean).map(real);
  const data = dataDir ? real(dataDir) : null;
  const tooBroad = (cwd) => {
    const dir = real(cwd);
    return (
      dir === path.parse(dir).root ||
      guarded.some((protectedDir) => within(protectedDir, dir)) ||
      (data !== null && within(dir, data))
    );
  };
  const grants = [];
  for (const definition of definitions) {
    if (definition.transport !== "stdio" || !definition.command) continue;
    const paths = new Set();
    const add = (file) => {
      paths.add(file);
      try {
        paths.add(realpath(file));
      } catch {
        // A missing link target is the command's own problem at start.
      }
    };
    add(definition.command);
    for (const file of [...paths])
      for (const program of interpreters(file, { pathEnv, readHead, exists }))
        add(program);
    for (const file of paths) grants.push({ access: "read", path: file });
    if (!definition.cwd) continue;
    if (tooBroad(definition.cwd))
      warn("An MCP server's working directory was not granted (MCP_CWD_TOO_BROAD).");
    else grants.push({ access: "allow", path: definition.cwd });
  }
  return grants;
}
