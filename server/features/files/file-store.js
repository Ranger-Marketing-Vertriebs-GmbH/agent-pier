import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDatabase } from "../../lib/private-database.js";
import { fileSchema, jobStates, terminalStates, retentionMs } from "./file-schema.js";
import { fileProblem } from "./file-errors.js";
import {
  validateOperation,
  projectEntry,
  projectConflict,
  progressPatch,
} from "./file-job-handlers.js";
import { readFileLimits } from "./file-limits.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function cursorValue(cursor, scope, collection) {
  if (cursor === undefined || cursor === null) return 0;
  try {
    if (typeof cursor !== "string" || cursor.length > 1024) throw Error();
    const data = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      data.scope !== scope.id ||
      data.collection !== collection ||
      !Number.isSafeInteger(data.after) ||
      data.after < 0
    )
      throw Error();
    return data.after;
  } catch {
    throw fileProblem("FILE_INVALID_CURSOR", 400);
  }
}
function page(rows, scope, collection, field, project) {
  const more = rows.length > 200;
  const selected = rows.slice(0, 200);
  return {
    [field]: selected.map(project),
    nextCursor: more
      ? Buffer.from(
          JSON.stringify({
            scope: scope.id,
            collection,
            after: selected.at(-1).sequence,
          }),
        ).toString("base64url")
      : null,
  };
}
function publicJob(row) {
  const doc = JSON.parse(row.document);
  return {
    id: row.id,
    kind: row.kind,
    scopeId: row.scope_id,
    status: row.status,
    completedEntries: doc.completedEntries,
    totalEntries: doc.totalEntries,
    completedBytes: doc.completedBytes,
    totalBytes: doc.totalBytes,
    conflict: projectConflict(doc.conflict),
    issue: doc.issue,
  };
}

/** Synchronous private journal. Construction recovers before consumers can register work. */
export class FileStore {
  constructor({ dataDir, now = Date.now, limits = readFileLimits() }) {
    this.now = now;
    this.limits = limits;
    this.storageRoot = path.resolve(dataDir, "files");
    this.db = privateDatabase(this.storageRoot, "files.sqlite");
    this.db.exec(fileSchema);
    this.db
      .prepare(
        "UPDATE jobs SET status='interrupted', updated_at=? WHERE status IN ('queued','running','waiting_for_conflict','cancelling')",
      )
      .run(now());
    this.prune(now());
  }
  request(scope, operation) {
    validateOperation(operation);
    const match =
      /^(\d{1,16}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(
        operation.requestId,
      );
    const now = this.now(),
      time = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(time) || time > now + 300000)
      throw fileProblem("FILE_INVALID_REQUEST", 400);
    if (time < now - retentionMs) throw fileProblem("FILE_REQUEST_EXPIRED", 410);
    const { requestId, ...body } = operation;
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(canonical(body)))
      .digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT * FROM requests WHERE scope_id=? AND request_id=?")
        .get(scope.id, requestId);
      if (prior) {
        if (prior.body_hash !== bodyHash) throw fileProblem("FILE_REQUEST_CONFLICT", 409);
        const job = this.getJob(scope, prior.job_id);
        this.db.exec("COMMIT");
        return { job, created: false };
      }
      if (operation.parentJobId) this.getJob(scope, operation.parentJobId);
      const id = randomUUID();
      const doc = {
        completedEntries: 0,
        totalEntries: null,
        completedBytes: 0,
        totalBytes: null,
        conflict: null,
        issue: null,
      };
      this.db
        .prepare(
          "INSERT INTO jobs(id,scope_id,kind,status,operation,document,parent_job_id,entry_id,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)",
        )
        .run(
          id,
          scope.id,
          operation.kind,
          JSON.stringify(operation),
          JSON.stringify(doc),
          operation.parentJobId ?? null,
          operation.entryId ?? null,
          now,
          now,
        );
      this.db
        .prepare("INSERT INTO requests VALUES(?,?,?,?,?)")
        .run(scope.id, requestId, bodyHash, id, now);
      const job = this.getJob(scope, id);
      this.db.exec("COMMIT");
      return { job, created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getJob(scope, id) {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE scope_id=? AND id=?")
      .get(scope.id, id);
    if (!row) throw fileProblem("FILE_NOT_FOUND", 404);
    return publicJob(row);
  }
  listJobs(scope, cursor) {
    const after = cursorValue(cursor, scope, "jobs");
    const rows = this.db
      .prepare(
        "SELECT rowid AS sequence,* FROM jobs WHERE scope_id=? AND rowid>? ORDER BY rowid LIMIT 201",
      )
      .all(scope.id, after);
    return page(rows, scope, "jobs", "jobs", publicJob);
  }
  // Private recovery/transfer consumers only. Never return these records from HTTP.
  getOperation(id) {
    const row = this.db.prepare("SELECT operation FROM jobs WHERE id=?").get(id);
    return row ? JSON.parse(row.operation) : null;
  }
  getDecision(id) {
    const row = this.db.prepare("SELECT document FROM jobs WHERE id=?").get(id);
    return row ? (JSON.parse(row.document).decision ?? null) : null;
  }
  putEntry(jobId, entry) {
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256)
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    const encoded = JSON.stringify(entry);
    if (Buffer.byteLength(encoded) > 64 * 1024)
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    const kind = this.getOperation(jobId)?.kind;
    const entryLimit = ["search", "size"].includes(kind)
      ? this.limits.searchResults
      : this.limits.jobEntries;
    const existing = this.db
      .prepare("SELECT 1 FROM job_entries WHERE job_id=? AND id=?")
      .get(jobId, entry.id);
    if (
      !existing &&
      this.db
        .prepare("SELECT count(*) AS total FROM job_entries WHERE job_id=?")
        .get(jobId).total >= entryLimit
    )
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    this.db
      .prepare(
        "INSERT INTO job_entries(job_id,id,document) VALUES(?,?,?) ON CONFLICT(job_id,id) DO UPDATE SET document=excluded.document",
      )
      .run(jobId, entry.id, encoded);
  }
  getEntry(jobId, id) {
    const row = this.db
      .prepare("SELECT document FROM job_entries WHERE job_id=? AND id=?")
      .get(jobId, id);
    return row ? JSON.parse(row.document) : null;
  }
  listEntries(scope, id, cursor) {
    this.getJob(scope, id);
    const collection = `entries:${id}`,
      after = cursorValue(cursor, scope, collection);
    const rows = this.db
      .prepare(
        "SELECT * FROM job_entries WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT 201",
      )
      .all(id, after);
    return page(rows, scope, collection, "entries", (row) =>
      projectEntry(JSON.parse(row.document)),
    );
  }
  transition(id, from, to, patch = {}) {
    if (!jobStates.includes(to) || !jobStates.includes(from))
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE id=? AND status=?")
      .get(id, from);
    if (!row) return null;
    const doc = {
      ...JSON.parse(row.document),
      ...progressPatch(patch, this.limits, row.kind),
    };
    if (Object.hasOwn(patch, "conflict")) doc.conflict = projectConflict(patch.conflict);
    if (Object.hasOwn(patch, "decision")) doc.decision = patch.decision;
    const result = this.db
      .prepare("UPDATE jobs SET status=?,document=?,updated_at=? WHERE id=? AND status=?")
      .run(to, JSON.stringify(doc), this.now(), id, from);
    return result.changes
      ? publicJob({ ...row, status: to, document: JSON.stringify(doc) })
      : null;
  }
  putPublication(record) {
    this.db
      .prepare(
        "INSERT INTO publications VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,document=excluded.document,updated_at=excluded.updated_at",
      )
      .run(
        record.id,
        record.jobId,
        record.phase,
        JSON.stringify(record.document),
        this.now(),
      );
  }
  getPublication(id) {
    const row = this.db.prepare("SELECT * FROM publications WHERE id=?").get(id);
    return row
      ? {
          id: row.id,
          jobId: row.job_id,
          phase: row.phase,
          document: JSON.parse(row.document),
          updatedAt: row.updated_at,
        }
      : null;
  }
  listPublications() {
    return this.db
      .prepare("SELECT id FROM publications ORDER BY rowid")
      .all()
      .map((row) => this.getPublication(row.id));
  }
  putTrash(record) {
    this.db
      .prepare(
        "INSERT INTO trash_entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
      )
      .run(
        record.id,
        record.jobId,
        record.scopeId,
        JSON.stringify(record),
        record.deletedAt,
      );
  }
  getTrash(id) {
    const row = this.db.prepare("SELECT document FROM trash_entries WHERE id=?").get(id);
    return row ? JSON.parse(row.document) : null;
  }
  listTrash(scope, cursor) {
    const after = cursorValue(cursor, scope, "trash");
    const rows = this.db
      .prepare(
        "SELECT rowid AS sequence,* FROM trash_entries WHERE scope_id=? AND rowid>? ORDER BY rowid LIMIT 201",
      )
      .all(scope.id, after);
    return page(rows, scope, "trash", "entries", (row) => {
      const doc = JSON.parse(row.document);
      return Object.fromEntries(
        ["id", "originalPath", "deletedAt", "type", "size", "reason"].map((k) => [
          k,
          doc[k] ?? null,
        ]),
      );
    });
  }
  prune(now = this.now()) {
    const terminal = terminalStates.map((s) => `'${s}'`).join(",");
    // Remove resolved journals before their owning jobs; unresolved records pin jobs.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `DELETE FROM publications WHERE phase='resolved' AND job_id IN (SELECT id FROM jobs WHERE updated_at<? AND status IN (${terminal}))`,
        )
        .run(now - retentionMs);
      // Iteration removes terminal children first; every remaining child conservatively pins its parent.
      let result;
      do {
        result = this.db
          .prepare(
            `DELETE FROM jobs WHERE updated_at<? AND status IN (${terminal}) AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM trash_entries t WHERE t.job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM jobs child WHERE child.parent_job_id=jobs.id)`,
          )
          .run(now - retentionMs);
      } while (result.changes);
      this.db.exec("COMMIT");
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
