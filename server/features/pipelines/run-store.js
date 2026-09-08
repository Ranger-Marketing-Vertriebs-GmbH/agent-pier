import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { problem } from "../../lib/storage.js";

export function runId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))
    throw problem("Invalid pipeline identifier.");
  return value;
}
export function privateRunDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.getuid && st.uid !== process.getuid())
  )
    throw problem("Unsafe pipeline storage.", 409);
  fs.chmodSync(dir, 0o700);
  return dir;
}
export class RunStore {
  constructor(dataDir, onChange = () => {}) {
    this.onChange = onChange;
    const root = fs.realpathSync(dataDir);
    this.directory = privateRunDirectory(path.join(root, "pipeline-runs"));
    const file = path.join(this.directory, "runs.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        const st = fs.lstatSync(file + suffix);
        if (
          !st.isFile() ||
          st.isSymbolicLink() ||
          st.nlink !== 1 ||
          (process.getuid && st.uid !== process.getuid())
        )
          throw problem("Unsafe pipeline database.", 409);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL);",
    );
  }
  get(id) {
    const row = this.db.prepare("SELECT doc FROM runs WHERE id=?").get(runId(id));
    if (!row) throw problem("Pipeline run not found.", 404);
    return JSON.parse(row.doc);
  }
  all() {
    return this.db
      .prepare("SELECT doc FROM runs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(r.doc));
  }
  create(run) {
    run.revision = 1;
    this.db
      .prepare("INSERT INTO runs VALUES(?,?,?)")
      .run(run.id, run.revision, JSON.stringify(run));
    this.onChange(structuredClone(run));
    return structuredClone(run);
  }
  save(run) {
    const old = run.revision;
    const next = { ...run, revision: old + 1 };
    const result = this.db
      .prepare("UPDATE runs SET revision=?,doc=? WHERE id=? AND revision=?")
      .run(next.revision, JSON.stringify(next), run.id, old);
    if (result.changes !== 1)
      throw problem("Pipeline run changed. Reload and retry.", 409);
    run.revision = next.revision;
    this.onChange(structuredClone(run));
    return run;
  }
  remove(id) {
    this.db.prepare("DELETE FROM runs WHERE id=?").run(runId(id));
  }
  close() {
    this.db.close();
  }
}
