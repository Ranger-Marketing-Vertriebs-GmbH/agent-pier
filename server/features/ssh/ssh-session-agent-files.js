// Folder removal and binary checks of the session SSH agents (ssh-session-agents.js).
import fs from "node:fs";
import path from "node:path";
import {
  codedError,
  executableOutside,
  foldersBetween,
  realPathOrNull,
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
