import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/** OpenClaw prefixes tools with the server name; names are validated so this is the identity. */
export const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;
export function sanitisedPrefix(name) {
  if (typeof name !== "string" || !namePattern.test(name))
    throw problem(serverMessages.mcpServers.invalidName);
  return name;
}

/** Whether `file` (links followed) is a regular file the owner may execute. */
export const executableFile = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The trimmed command when it is a plausible command text; else null. */
function commandText(command) {
  if (typeof command !== "string") return null;
  const value = command.trim();
  if (
    !value ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !value.isWellFormed()
  )
    return null;
  return value;
}

/** Bare names only: no directory part, no "." or ".." in any form. */
function bareName(value) {
  if (path.isAbsolute(value)) return null;
  if (value.includes("..")) return null;
  if (value.includes("/") || value.includes("\\")) return null;
  return value;
}

const directoryEntries = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Resolve a stdio command to an absolute path. Bare names are looked up on the
 * AgentPier service's PATH (not an interactive login shell) and the absolute path
 * is stored; the owner sees this resolved path. Absolute paths are kept as entered
 * but must be existing executable regular files.
 */
export function resolveCommand(
  command,
  { pathEnv = process.env.PATH ?? "", exists = executableFile } = {},
) {
  const fail = () => problem(serverMessages.mcpServers.commandNotFound);
  const value = commandText(command);
  if (value === null) throw fail();
  if (path.isAbsolute(value)) {
    if (!exists(value)) throw fail();
    return value;
  }
  if (value.includes("/") || value.includes("\\")) throw fail();
  for (const dir of String(pathEnv).split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, value);
    if (exists(candidate)) return candidate;
  }
  throw fail();
}

/**
 * The wizard's lookup before a save: the path a save would store, or null. It answers
 * a request's question ("is there such a file?"), so it never passes a path spelled
 * by the request to the file system. Bare names are joined to PATH directories;
 * absolute paths are walked from "/" one listed directory entry at a time, so the
 * checked path consists only of names the file system itself returned.
 */
export function findCommand(
  command,
  {
    pathEnv = process.env.PATH ?? "",
    exists = executableFile,
    list = directoryEntries,
  } = {},
) {
  const value = commandText(command);
  if (value === null) return null;
  if (path.isAbsolute(value)) {
    // ".." would be resolved by text here but through links by a save: not found.
    if (value.split(path.sep).includes("..")) return null;
    let current = path.sep;
    for (const segment of path.normalize(value).split(path.sep).filter(Boolean)) {
      const entry = list(current).find((name) => name === segment);
      if (entry === undefined) return null;
      current = path.join(current, entry);
    }
    return exists(current) ? value : null;
  }
  const name = bareName(value);
  if (name === null) return null;
  for (const dir of String(pathEnv).split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}
