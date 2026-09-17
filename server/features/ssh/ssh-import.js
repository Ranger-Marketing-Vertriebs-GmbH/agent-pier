import fs from "node:fs";
import path from "node:path";
import { sshPhysicalRoot } from "./ssh-root.js";
import { sshProblem } from "./ssh-errors.js";

const refused = () =>
  sshProblem("SSH_IMPORT_SOURCE", "SSH import source is unavailable or unsupported.");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

export function sshImportPath(sourcePath, home) {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length > 4096 ||
    /[\x00-\x1f*?\[\]]/.test(sourcePath)
  )
    throw refused();
  const expanded =
    sourcePath.startsWith("~/") && path.isAbsolute(home || "")
      ? path.join(home, sourcePath.slice(2))
      : sourcePath;
  if (!path.isAbsolute(expanded)) throw refused();
  return path.normalize(expanded);
}

export function readSshImport({ sourcePath, home, dataDir, identityPaths = [] }) {
  let fd;
  try {
    const source = sshImportPath(sourcePath, home);
    const initial = fs.lstatSync(source, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) throw refused();
    const canonical = fs.realpathSync(source);
    if (
      inside(fs.realpathSync(dataDir), canonical) ||
      inside(sshPhysicalRoot(dataDir), canonical)
    )
      throw refused();
    const parent = fs.statSync(path.dirname(canonical), { bigint: true });
    fd = fs.openSync(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      !same(opened, initial) ||
      opened.size > 65536n ||
      (process.getuid && opened.uid !== BigInt(process.getuid()))
    )
      throw refused();
    for (const identity of identityPaths) {
      try {
        if (same(opened, fs.statSync(identity, { bigint: true }))) throw refused();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const buffer = Buffer.alloc(65537);
    let size = 0,
      count;
    do {
      count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      size += count;
    } while (count && size < buffer.length);
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      !size ||
      size > 65536 ||
      !same(after, opened) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      fs.realpathSync(source) !== canonical ||
      !same(fs.lstatSync(source, { bigint: true }), opened) ||
      !same(fs.statSync(path.dirname(canonical), { bigint: true }), parent)
    )
      throw refused();
    return buffer.subarray(0, size);
  } catch {
    throw refused();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
