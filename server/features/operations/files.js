import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { problem } from "../../lib/storage.js";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value))
    throw problem("Invalid operation identifier.");
  return value;
}
export function relativeName(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\\\x00-\x1f]/.test(value) ||
    path.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw problem("Invalid archive member path.");
  return value;
}
export function folder(dir) {
  const absolute = path.resolve(dir);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw problem("Operation directory contains a link or non-directory.", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  const stat = fs.statSync(absolute);
  if (process.getuid && stat.uid !== process.getuid())
    throw problem("Operation directory is owned by another user.", 409);
  fs.chmodSync(absolute, 0o700);
  return absolute;
}
export function readFile(file, limit = 256 * 1024 * 1024) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw problem("Invalid operation file or size limit exceeded.", 413);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function readJson(file, fallback) {
  try {
    return JSON.parse(readFile(file, 16 * 1024 * 1024));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
export function atomic(file, value) {
  folder(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, Buffer.isBuffer(value) ? value : JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function members(
  root,
  prefix = "",
  { exclude = () => false, limit = 256 * 1024 * 1024 } = {},
) {
  const result = [];
  let bytes = 0;
  function visit(relative) {
    const file = path.join(root, relative),
      stat = fs.lstatSync(file);
    if (exclude(relative)) return;
    if (stat.isSymbolicLink())
      throw problem("Backup component contains a symbolic link.", 409);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    } else {
      const content = readFile(file, limit);
      bytes += content.length;
      if (bytes > limit || result.length >= 20000)
        throw problem("Backup component exceeds its limit.", 413);
      result.push({
        path: relativeName([prefix, relative].filter(Boolean).join("/")),
        content: content.toString("base64"),
        sha256: digest(content),
        mode: 0o600,
      });
    }
  }
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root).sort()) visit(name);
  return result;
}
