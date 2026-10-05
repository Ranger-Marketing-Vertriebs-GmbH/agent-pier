import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export class DatabaseLocationError extends Error {
  constructor(reason) {
    super(`SQLite database is ${reason}`);
    this.reason = reason; // "unsafe" | "partial-wal"
  }
}

/** A regular database below root with consistent WAL sidecars, or null when absent. */
export async function locateDatabase(root, file) {
  try {
    const [realRoot, realFile, stat] = await Promise.all([
      fs.realpath(root),
      fs.realpath(file),
      fs.lstat(file),
    ]);
    if (
      !realFile.startsWith(realRoot + path.sep) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1
    )
      throw new DatabaseLocationError("unsafe");
    const sidecars = [];
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = await fs.lstat(file + suffix).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      sidecars.push(Boolean(sidecar));
      if (
        sidecar &&
        (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1)
      )
        throw new DatabaseLocationError("unsafe");
    }
    if (sidecars[0] !== sidecars[1]) throw new DatabaseLocationError("partial-wal");
    return {
      file: realFile,
      identity: `${stat.dev}:${stat.ino}`,
      version: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      immutable: !sidecars[0],
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Read-only connection inside an open transaction. Even READONLY SQLite creates WAL
 * sidecars for a checkpointed database; without sidecars it is opened immutable.
 */
export function openDatabase(location) {
  const { DatabaseSync } = require("node:sqlite");
  const url = pathToFileURL(location.file);
  if (location.immutable) url.search = "?mode=ro&immutable=1";
  const db = new DatabaseSync(location.immutable ? url.href : location.file, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    db.exec(
      "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500; BEGIN",
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** An immutable read must have seen the same file it located. */
export async function unchangedDatabase(root, file, location) {
  if (!location.immutable) return true;
  const after = await locateDatabase(root, file).catch(() => null);
  return Boolean(
    after?.immutable &&
    after.identity === location.identity &&
    after.version === location.version,
  );
}

export function hasColumns(db, table, columns) {
  const names = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  return columns.every((column) => names.has(column));
}
