import fs from "node:fs";
import path from "node:path";
import { resolveCommand } from "./command-resolution.js";

function head(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(256);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, 256, 0)).toString("utf8");
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
 * file it links to and its interpreters; full access to its working directory.
 * Remote servers need none.
 */
export function stdioGrants(
  definitions,
  { pathEnv = "", readHead = head, realpath = fs.realpathSync, exists } = {},
) {
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
    if (definition.cwd) grants.push({ access: "allow", path: definition.cwd });
  }
  return grants;
}
