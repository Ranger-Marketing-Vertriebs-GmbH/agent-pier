import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { failure, storageRoot } from "./memory-validation.js";
export function openDatabase(dataDir) {
  const root = storageRoot(dataDir);
  const file = path.join(root, "memory.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = file + suffix;
    try {
      const stat = fs.lstatSync(target);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.isSymbolicLink() ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw failure("Unsafe memory storage.", 409);
      fs.chmodSync(target, 0o600);
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
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions (entry_id TEXT NOT NULL REFERENCES entries(id), revision INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, archived INTEGER NOT NULL, created_at TEXT NOT NULL, provenance TEXT NOT NULL, PRIMARY KEY(entry_id,revision));
 CREATE TABLE IF NOT EXISTS requests (project_id TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL, hash TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(project_id,actor,request_id));
 CREATE TABLE IF NOT EXISTS capabilities (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), account_id TEXT NOT NULL, tool TEXT NOT NULL, token_hash TEXT NOT NULL, active INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS entries_by_project ON entries(project_id);
 PRAGMA user_version=1;`);
    for (const suffix of ["-wal", "-shm"])
      try {
        fs.chmodSync(file + suffix, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
  } catch (error) {
    db.close();
    throw error;
  }
  return { root, db };
}
export function transaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
