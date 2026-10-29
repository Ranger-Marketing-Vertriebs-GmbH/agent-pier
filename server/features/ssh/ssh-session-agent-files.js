// Folder removal and binary checks of the session SSH agents (ssh-session-agents.js).
import fs from "node:fs";
import path from "node:path";

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function realOrSelf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// A recorded binary that still is an executable file outside the session wrappers.
function usableBinary(file, skipRoot) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file))
    return false;
  try {
    const real = fs.realpathSync(file);
    if (real === skipRoot || real.startsWith(`${skipRoot}${path.sep}`)) return false;
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

// Removes `target` below `top` when every folder from `top` down to its parent is a
// real directory. A link at `target` is unlinked, never followed; rmSync does not
// follow links inside it either.
export function removeBelow(top, target) {
  const relative = path.relative(top, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw codedError("SSH_FOLDER_UNSAFE", "Unsafe session SSH folder");
  let folder = top;
  for (const part of ["", ...relative.split(path.sep).slice(0, -1)]) {
    folder = path.join(folder, part);
    const stat = lstatOrNull(folder);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw codedError("SSH_FOLDER_UNSAFE", "Unsafe session SSH folder");
  }
  const stat = lstatOrNull(target);
  if (!stat) return;
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
}
