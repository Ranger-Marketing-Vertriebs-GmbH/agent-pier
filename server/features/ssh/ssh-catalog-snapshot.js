import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "../../lib/storage.js";

/** Persist each cutover boundary before advancing to the next phase. */
export function writeCatalogSnapshot(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    // Publication already happened; never report rollback after this boundary.
    try {
      const directory = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch {
      /* Some filesystems do not support directory synchronization. */
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
