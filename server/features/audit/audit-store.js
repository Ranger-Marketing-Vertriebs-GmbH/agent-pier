import { serverMessages } from "../../lib/i18n/de.js";
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
  list({ page = 1, action, outcome, sessionId, projectId, resourceId, before } = {}) {
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
        throw problem(serverMessages.audit.invalidOutcome);
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
    // One resource, e.g. a Zugänge entry ("Im Aktivitätsprotokoll").
    if (resourceId) {
      clauses.push("json_extract(document,'$.resourceId')=?");
      values.push(auditId(resourceId));
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
  /**
   * The newest successful event since `since` (ISO time) with one of `actions` that
   * names `id` as its resource or as the decided action, or null. Events are appended
   * in time order, so the first event of the window is found by a binary search over
   * the primary key; only that window is read.
   */
  recent({ actions, id, since }) {
    const first = this.firstSince(since);
    if (first === null || !actions.length) return null;
    const row = this.db
      .prepare(
        `SELECT id,document FROM events WHERE id>=? AND action IN (${actions.map(() => "?").join(",")}) AND outcome='success' AND created_at>=? AND (json_extract(document,'$.resourceId')=? OR json_extract(document,'$.details.actionId')=?) ORDER BY id DESC LIMIT 1`,
      )
      .get(first, ...actions, since, id, id);
    return row ? { ...JSON.parse(row.document), id: String(row.id) } : null;
  }
  /**
   * The newest event time per resource id among events with one of `actions`, any
   * outcome (connection-last-use.js). Reads only those actions through their index.
   */
  latestByResource(actions) {
    if (!actions.length) return new Map();
    const rows = this.db
      .prepare(
        `SELECT json_extract(document,'$.resourceId') AS resource, MAX(created_at) AS at FROM events WHERE action IN (${actions.map(() => "?").join(",")}) GROUP BY resource`,
      )
      .all(...actions.map((action) => auditAction(action)));
    return new Map(
      rows
        .filter((row) => typeof row.resource === "string" && row.resource)
        .map((row) => [row.resource, row.at]),
    );
  }
  firstSince(since) {
    const bounds = this.db
      .prepare("SELECT MIN(id) AS low, MAX(id) AS high FROM events")
      .get();
    if (bounds.high === null) return null;
    const next = this.db.prepare(
      "SELECT id,created_at FROM events WHERE id>=? ORDER BY id LIMIT 1",
    );
    let low = bounds.low,
      high = bounds.high + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const row = next.get(middle);
      if (!row) high = middle;
      else if (row.created_at >= since) high = middle;
      else low = row.id + 1;
    }
    return low > bounds.high ? null : low;
  }
  export() {
    return this.db
      .prepare("SELECT id,document FROM events ORDER BY id")
      .all()
      .map((row) => ({ ...JSON.parse(row.document), id: String(row.id) }));
  }
  importEvents(events) {
    if (!Array.isArray(events)) throw problem(serverMessages.audit.invalidArchive);
    let previous = 0;
    const records = events.map((input) => {
      const id = auditInteger(input?.id, "identifier", { min: 1 });
      if (id <= previous || String(id) !== input.id)
        throw problem(serverMessages.audit.archiveIdsUnordered);
      previous = id;
      if (
        typeof input.createdAt !== "string" ||
        !Number.isFinite(Date.parse(input.createdAt)) ||
        new Date(input.createdAt).toISOString() !== input.createdAt
      )
        throw problem(serverMessages.audit.invalidArchiveTimestamp);
      const event = { ...auditEvent(input), createdAt: input.createdAt };
      if (!isDeepStrictEqual({ ...event, id: input.id }, input))
        throw problem(serverMessages.audit.invalidArchiveMetadata);
      return { id, event };
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT COUNT(*) AS count FROM events").get().count)
        throw problem(serverMessages.audit.restoreRequiresEmptyTarget, 409);
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
