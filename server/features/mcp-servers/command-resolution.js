import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/** OpenClaw prefixes tools with the server name; names are validated so this is the identity. */
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;
export function sanitisedPrefix(name) {
  if (typeof name !== "string" || !namePattern.test(name))
    throw problem(serverMessages.mcpServers.invalidName);
  return name;
}

const executableFile = (file) => {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
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
  if (typeof command !== "string") throw fail();
  const value = command.trim();
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw fail();
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
