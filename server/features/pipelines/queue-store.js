import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";

/**
 * Durable queue items. An item's id is the run id reserved for it when it was added,
 * so a start interrupted by a restart retries with the same id and can never start a
 * second run. Items are runtime state like the MCP start registry, not part of backups.
 */
export class QueueStore {
  constructor(dataDir) {
    this.db = privateDatabase(path.join(dataDir, "pipeline-queue"), "queue.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL, state TEXT NOT NULL, doc TEXT NOT NULL); CREATE INDEX IF NOT EXISTS items_project ON items(project_id, position);",
    );
  }
  find(id) {
    const row = this.db.prepare("SELECT doc FROM items WHERE id=?").get(id);
    return row ? JSON.parse(row.doc) : null;
  }
  get(projectId, id) {
    const item = typeof id === "string" ? this.find(id) : null;
    if (!item || item.projectId !== projectId)
      throw problem(serverMessages.pipelineQueue.itemNotFound, 404);
    return item;
  }
  /** A project's items in queue order. */
  list(projectId) {
    return this.db
      .prepare("SELECT doc FROM items WHERE project_id=? ORDER BY position")
      .all(projectId)
      .map((row) => JSON.parse(row.doc));
  }
  withState(state) {
    return this.db
      .prepare("SELECT doc FROM items WHERE state=? ORDER BY position")
      .all(state)
      .map((row) => JSON.parse(row.doc));
  }
  projectsWithState(state) {
    return this.db
      .prepare("SELECT DISTINCT project_id FROM items WHERE state=?")
      .all(state)
      .map((row) => row.project_id);
  }
  count(projectId, states) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM items WHERE project_id=? AND state IN (${states.map(() => "?").join(",")})`,
      )
      .get(projectId, ...states).count;
  }
  /** Appends an item at the end of its project's queue. */
  insert(item) {
    const { last } = this.db
      .prepare("SELECT MAX(position) AS last FROM items WHERE project_id=?")
      .get(item.projectId);
    const row = { ...item, position: (last ?? 0) + 1 };
    this.db
      .prepare("INSERT INTO items VALUES(?,?,?,?,?)")
      .run(row.id, row.projectId, row.position, row.state, JSON.stringify(row));
    return row;
  }
  save(item) {
    this.db
      .prepare("UPDATE items SET position=?,state=?,doc=? WHERE id=?")
      .run(item.position, item.state, JSON.stringify(item), item.id);
    return item;
  }
  /** Exchanges the positions of two items of one project in one transaction. */
  swap(a, b) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save({ ...a, position: b.position });
      this.save({ ...b, position: a.position });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Moves a project's items behind the target project's items, keeping their order. */
  moveProject(fromId, toId, cwd) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { last } = this.db
        .prepare("SELECT MAX(position) AS last FROM items WHERE project_id=?")
        .get(toId);
      let position = last ?? 0;
      for (const item of this.list(fromId)) {
        const moved = { ...item, projectId: toId, position: ++position };
        if (cwd) moved.cwd = cwd;
        this.db
          .prepare("UPDATE items SET project_id=?,position=?,doc=? WHERE id=?")
          .run(toId, moved.position, JSON.stringify(moved), item.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  remove(id) {
    this.db.prepare("DELETE FROM items WHERE id=?").run(id);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
