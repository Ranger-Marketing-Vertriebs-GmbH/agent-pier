// Folder removal, binary checks and the stored agent of session records, for the
// session SSH agents (ssh-session-agents.js).
import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { sshAgentHandle } from "../sessions/session-ssh-agent-record.js";
import {
  codedError,
  executableOutside,
  foldersBetween,
  realPathOrNull,
  tokenPattern,
  validSessionId,
} from "./ssh-agent-shared.js";

export const realOrSelf = (file) => realPathOrNull(file) ?? path.resolve(file);

// A recorded binary that still is an executable file outside the session wrappers.
function usableBinary(file, skipRoot) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file))
    return false;
  return executableOutside(file, [skipRoot]);
}

// The binaries kept in the record at prepare time, or null once `ssh` is gone.
export function recordedBinaries(binaries, skipRoot) {
  if (!usableBinary(binaries?.ssh, skipRoot)) return null;
  const found = {};
  for (const name of ["ssh", "scp", "sftp"])
    if (usableBinary(binaries[name], skipRoot)) found[name] = binaries[name];
  return found;
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const unsafeFolder = () => codedError("SSH_FOLDER_UNSAFE", "Unsafe session SSH folder");

// Removes `target` below `top` when every folder from `top` down to its parent is a
// real directory. A link at `target` is unlinked, never followed; rmSync does not
// follow links inside it either.
export function removeBelow(top, target) {
  for (const folder of foldersBetween(top, target, unsafeFolder).slice(0, -1)) {
    const stat = lstatOrNull(folder);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeFolder();
  }
  const stat = lstatOrNull(target);
  if (!stat) return;
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}

// The generation and token through the record parser; the binaries as stored, since
// restore() checks each one itself and falls back to PATH when `ssh` is gone.
export function storedAgent(record, id) {
  const agent = record?.id === id ? record.sshAgent : null;
  const handle = sshAgentHandle(agent);
  return handle ? { ...handle, binaries: agent.binaries } : null;
}

// The socket token a record names: its agent's, or the one a reload's stop retired
// (`sshAgentRetired`, session-replacement.js), which never authorizes anything but
// still locates the socket folder for a later prepare or discard.
export function storedToken(record, id) {
  const token = storedAgent(record, id)?.token ?? record?.sshAgentRetired?.token;
  return record?.id === id && typeof token === "string" && tokenPattern.test(token)
    ? token
    : undefined;
}

/** A session's record, or null when it is missing, unreadable or not that session's. */
export function sessionRecord(dataDir, id) {
  try {
    const value = readJSON(path.join(dataDir, "sessions", `${id}.json`), null);
    return value && typeof value === "object" && value.id === id ? value : null;
  } catch {
    return null;
  }
}

/** `[{ id, token }]` of every session record that names a socket token. */
export function storedSessionTokens(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dataDir, "sessions"));
  } catch {
    return [];
  }
  const tokens = [];
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : null;
    if (!validSessionId(id)) continue;
    const token = storedToken(sessionRecord(dataDir, id), id);
    if (token) tokens.push({ id, token });
  }
  return tokens;
}
