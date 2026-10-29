import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { problem } from "../../lib/storage.js";

export function runId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))
    throw problem(serverMessages.pipelines.invalidIdentifier);
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
    throw problem(serverMessages.pipelines.unsafeStorage, 409);
  fs.chmodSync(dir, 0o700);
  return dir;
}
// Run lists filter on these fields; an expression index serves a query only when it
// uses the same expression, so the filters below repeat them exactly.
const FIELDS = {
  status: "json_extract(doc,'$.status')",
  projectId: "json_extract(doc,'$.projectId')",
};
export class RunStore {
  /**
   * `onChange(run)` hears every created or saved run, `onRemove(id)` every removed
   * one, so the lists and topics that showed it learn it without wrapping the engine.
   */
  constructor(dataDir, onChange = () => {}, { onRemove = () => {} } = {}) {
    this.onChange = onChange;
    this.onRemove = onRemove;
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
          throw problem(serverMessages.pipelines.unsafeDatabase, 409);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL);",
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS runs_status ON runs(${FIELDS.status}); CREATE INDEX IF NOT EXISTS runs_project ON runs(${FIELDS.projectId});`,
    );
  }
  get(id) {
    const row = this.db.prepare("SELECT doc FROM runs WHERE id=?").get(runId(id));
    if (!row) throw problem(serverMessages.pipelines.runNotFound, 404);
    return normalizeRun(JSON.parse(row.doc));
  }
  /** Runs with this status, newest first (the owner's inbox reads waiting runs). */
  withStatus(status) {
    return this.db
      .prepare(`SELECT doc FROM runs WHERE ${FIELDS.status}=? ORDER BY rowid DESC`)
      .all(status)
      .map((r) => normalizeRun(JSON.parse(r.doc)));
  }
  /** Whether any run belongs to the project. */
  hasProject(projectId) {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM runs WHERE ${FIELDS.projectId}=? LIMIT 1`)
        .get(projectId),
    );
  }
  /**
   * One page of runs, newest first, with optional status and project filters, and
   * how many runs match: SQLite filters the stored JSON through the field indexes
   * (only the filters given, so each can use its index), only the page is parsed.
   */
  page({ status, projectId, offset = 0, limit = 20 } = {}) {
    const given = Object.entries({ status, projectId }).filter(([, v]) => v != null);
    const where = given.length
      ? `WHERE ${given.map(([field]) => `${FIELDS[field]}=?`).join(" AND ")}`
      : "";
    const filters = given.map(([, value]) => value);
    const { total } = this.db
      .prepare(`SELECT COUNT(*) AS total FROM runs ${where}`)
      .get(...filters);
    const runs = this.db
      .prepare(`SELECT doc FROM runs ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(...filters, limit, offset)
      .map((r) => normalizeRun(JSON.parse(r.doc)));
    return { runs, total: Number(total) };
  }
  all() {
    return this.db
      .prepare("SELECT doc FROM runs ORDER BY rowid DESC")
      .all()
      .map((r) => normalizeRun(JSON.parse(r.doc)));
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
    if (result.changes !== 1) throw problem(serverMessages.pipelines.runChanged, 409);
    run.revision = next.revision;
    this.onChange(structuredClone(run));
    return run;
  }
  remove(id) {
    const { changes } = this.db.prepare("DELETE FROM runs WHERE id=?").run(runId(id));
    if (changes) this.onRemove(id);
  }
  close() {
    this.db.close();
  }
}

// Earlier builds recorded the per-turn wall-clock bound as "stage-timeout".
const legacyReasons = { "stage-timeout": "turn-timeout" };
export function normalizeRun(run) {
  for (const entry of [...(run.nodes || []), ...(run.executionLog || [])])
    if (Object.hasOwn(legacyReasons, entry?.failReason))
      entry.failReason = legacyReasons[entry.failReason];
  // Earlier builds kept one active turn per run; a run now keeps one per stage, so a
  // parallel group's members can run at the same time. This build never writes
  // `activeTurn`, so a run that has it was last saved by an earlier build: its turn is
  // the only active one, and turns an earlier build kept unread are stale.
  if (Object.hasOwn(run, "activeTurn")) {
    const turn = run.activeTurn;
    run.activeTurns =
      turn && typeof turn.nodeId === "string" ? { [turn.nodeId]: turn } : {};
    delete run.activeTurn;
  }
  run.activeTurns ??= {};
  return run;
}
