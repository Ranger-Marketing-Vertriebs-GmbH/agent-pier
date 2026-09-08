import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { privateDatabase } from "../../lib/private-database.js";
import { problem } from "../../lib/storage.js";
import { auditEvent, auditAction, auditId, auditInteger } from "./audit-schema.js";

export class AuditStore {
  constructor({ dataDir, clock = Date }) {
    this.clock = clock;
    this.db = privateDatabase(path.join(dataDir, "audit"), "audit.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, session_id TEXT, project_id TEXT, document TEXT NOT NULL); CREATE INDEX IF NOT EXISTS audit_action ON events(action,id); CREATE INDEX IF NOT EXISTS audit_session ON events(session_id,id); PRAGMA user_version=1;",
    );
  }
  append(input) {
    const event = {
      ...auditEvent(input),
      createdAt: new Date(this.clock.now()).toISOString(),
    };
    const result = this.db
      .prepare(
        "INSERT INTO events (created_at,action,outcome,session_id,project_id,document) VALUES(?,?,?,?,?,?)",
      )
      .run(
        event.createdAt,
        event.action,
        event.outcome,
        event.sessionId ?? null,
        event.projectId ?? null,
        JSON.stringify(event),
      );
    return { ...event, id: String(result.lastInsertRowid) };
  }
  list({ page = 1, action, outcome, sessionId, projectId, before } = {}) {
    page = auditInteger(page, "page", { min: 1, max: 100000 });
    const boundary =
      before === undefined
        ? this.db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events").get().id
        : auditInteger(before, "boundary");
    const clauses = ["id<=?"],
      values = [boundary];
    if (action) {
      clauses.push("action=?");
      values.push(auditAction(action));
    }
    if (outcome) {
      if (!["success", "failure"].includes(outcome))
        throw problem("Invalid audit outcome.");
      clauses.push("outcome=?");
      values.push(outcome);
    }
    for (const [column, value] of [
      ["session_id", sessionId],
      ["project_id", projectId],
    ])
      if (value) {
        clauses.push(`${column}=?`);
        values.push(auditId(value));
      }
    const where = clauses.join(" AND ");
    const total = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events WHERE ${where}`)
      .get(...values).count;
    const events = this.db
      .prepare(
        `SELECT id,document FROM events WHERE ${where} ORDER BY id DESC LIMIT 25 OFFSET ?`,
      )
      .all(...values, (page - 1) * 25)
      .map((row) => ({ ...JSON.parse(row.document), id: String(row.id) }));
    return { events, total, page, pageSize: 25, before: String(boundary) };
  }
  export() {
    return this.db
      .prepare("SELECT id,document FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...JSON.parse(row.document), id: String(row.id) }));
  }
  importEvents(events) {
    if (!Array.isArray(events)) throw problem("Invalid audit archive.");
    let previous = 0;
    const records = events.map((input) => {
      const id = auditInteger(input?.id, "identifier", { min: 1 });
      if (id <= previous || String(id) !== input.id)
        throw problem("Audit archive identifiers must be ordered and unique.");
      previous = id;
      if (
        typeof input.createdAt !== "string" ||
        !Number.isFinite(Date.parse(input.createdAt)) ||
        new Date(input.createdAt).toISOString() !== input.createdAt
      )
        throw problem("Invalid audit archive timestamp.");
      const event = { ...auditEvent(input), createdAt: input.createdAt };
      if (!isDeepStrictEqual({ ...event, id: input.id }, input))
        throw problem("Invalid audit archive metadata.");
      return { id, event };
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT COUNT(*) AS count FROM events").get().count)
        throw problem("Audit restore requires an empty target.", 409);
      const insert = this.db.prepare(
        "INSERT INTO events (id,created_at,action,outcome,session_id,project_id,document) VALUES(?,?,?,?,?,?,?)",
      );
      for (const { id, event } of records)
        insert.run(
          id,
          event.createdAt,
          event.action,
          event.outcome,
          event.sessionId ?? null,
          event.projectId ?? null,
          JSON.stringify(event),
        );
      this.db.exec("COMMIT");
      return { imported: records.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
