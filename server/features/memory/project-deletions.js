import { transaction } from "./memory-database.js";
import { forgetIndexed } from "./memory-search.js";

const row = (value) => ({
  path: value.path,
  state: value.state,
  error: value.error,
  body: JSON.parse(value.body),
  createdAt: value.created_at,
  updatedAt: value.updated_at,
});

/** Durable records of project deletions in progress or failed; see ProjectDeletion. */
export class DeletionRecords {
  constructor(db) {
    this.db = db;
  }
  list() {
    return this.db
      .prepare("SELECT * FROM project_deletions ORDER BY created_at,path")
      .all()
      .map(row);
  }
  get(path) {
    const found = this.db
      .prepare("SELECT * FROM project_deletions WHERE path=?")
      .get(path);
    return found ? row(found) : null;
  }
  /** Starts, or restarts with a new body, the deletion of a folder. */
  mark(path, body) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO project_deletions (path,state,body,error,created_at,updated_at)
         VALUES (?,'deleting',?,NULL,?,?)
         ON CONFLICT(path) DO UPDATE SET state='deleting',body=excluded.body,error=NULL,updated_at=excluded.updated_at`,
      )
      .run(path, JSON.stringify(body), now, now);
    return this.get(path);
  }
  fail(path, code) {
    this.db
      .prepare(
        "UPDATE project_deletions SET state='failed',error=?,updated_at=? WHERE path=?",
      )
      .run(String(code), new Date().toISOString(), path);
  }
  again(path) {
    this.db
      .prepare(
        "UPDATE project_deletions SET state='deleting',error=NULL,updated_at=? WHERE path=?",
      )
      .run(new Date().toISOString(), path);
    return this.get(path);
  }
  drop(path) {
    this.db.prepare("DELETE FROM project_deletions WHERE path=?").run(path);
  }
}

const inList = (ids) => ids.map(() => "?").join(",");

/**
 * Removes projects with everything memory holds about them: entries, revisions,
 * search index terms, request receipts, tombstones, session capabilities, rebinds
 * and merges. One transaction; returns the number of rows deleted.
 */
export function purgeProjects(memory, ids) {
  if (!ids.length) return 0;
  const { db } = memory;
  const marks = inList(ids);
  return transaction(db, () => {
    let removed = 0;
    const run = (sql, params = ids) => {
      removed += Number(db.prepare(sql).run(...params).changes);
    };
    const entryIds = db
      .prepare(`SELECT id FROM entries WHERE project_id IN (${marks})`)
      .all(...ids)
      .map((entry) => entry.id);
    for (const id of entryIds) forgetIndexed(memory, id);
    run(
      `DELETE FROM revisions WHERE entry_id IN (SELECT id FROM entries WHERE project_id IN (${marks}))`,
    );
    for (const id of entryIds) run("DELETE FROM purges WHERE entry_id=?", [id]);
    for (const table of ["requests", "tombstones", "capabilities", "entries"])
      run(`DELETE FROM ${table} WHERE project_id IN (${marks})`);
    for (const table of ["project_rebinds", "project_merges"])
      run(`DELETE FROM ${table} WHERE from_id IN (${marks}) OR to_id IN (${marks})`, [
        ...ids,
        ...ids,
      ]);
    run(`DELETE FROM projects WHERE id IN (${marks})`);
    return removed;
  });
}
