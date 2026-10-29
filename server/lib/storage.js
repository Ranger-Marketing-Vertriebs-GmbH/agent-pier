import { serverMessages } from "./i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}
export function writePrivate(file, value) {
  privateDirectory(path.dirname(file));
  writePrivateText(file, JSON.stringify(value, null, 2) + "\n");
}
/**
 * Create or verify one owner-only folder without following a symlink at its path.
 * `unsafe` builds the error for a symlink, a non-directory or a foreign owner.
 */
export function privateFolder(folder, unsafe = () => new Error("Unsafe private folder")) {
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
    throw unsafe();
  fs.chmodSync(folder, 0o700);
  return folder;
}
/**
 * Write text to a private file in an existing folder: a fresh exclusive temp name
 * (never a followed link), then an atomic rename that replaces whatever is at `file`.
 */
export function writePrivateText(file, text, mode = 0o600) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function nameValue(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 100 ||
    /[\x00-\x1f]/.test(value)
  )
    throw problem(serverMessages.common.invalidName);
  return value.trim();
}
