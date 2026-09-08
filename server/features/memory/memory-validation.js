import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { problem } from "../../lib/storage.js";
export const failure = problem;
export function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))
    throw failure("Invalid memory identifier.");
  return value;
}
export function pageValue(value = 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100000)
    throw failure("Invalid memory page.");
  return value;
}
export function textValue(value, name, max, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    Buffer.byteLength(value) > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw failure(`Invalid memory ${name}.`);
  return value;
}
export function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure("Invalid memory input.");
  return value;
}
export function privateFolder(folder) {
  try {
    fs.mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(folder);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw failure("Unsafe memory storage.", 409);
  fs.chmodSync(folder, 0o700);
  return folder;
}
export function privateFile(file, { missing = false, max = 8192 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > max ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw failure("Unsafe memory storage.", 409);
    return fs.readFileSync(fd, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && missing) return null;
    if (error.status) throw error;
    throw failure("Memory access is unavailable.", 403);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function writePrivateJson(file, value) {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function storageRoot(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return privateFolder(path.join(fs.realpathSync(dataDir), "memory"));
}
