import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { problem } from "./storage.js";

/** Reject filesystem aliases before opening application-owned SQLite storage. */
export function privateDatabase(directory, name) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = fs.lstatSync(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (process.getuid && root.uid !== process.getuid())
  )
    throw problem("Unsafe database storage directory.", 409);
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, name);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const info = fs.lstatSync(file + suffix);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw problem("Unsafe database storage file.", 409);
      fs.chmodSync(file + suffix, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!fs.existsSync(file))
    fs.closeSync(
      fs.openSync(
        file,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      ),
    );
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    for (const suffix of ["-wal", "-shm"])
      if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
