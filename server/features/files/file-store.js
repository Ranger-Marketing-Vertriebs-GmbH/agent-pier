import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDatabase } from "../../lib/private-database.js";
import {
  fileSchema,
  trashItemSchema,
  jobStates,
  terminalStates,
  retentionMs,
} from "./file-schema.js";
import { fileProblem } from "./file-errors.js";
import {
  validateOperation,
  projectEntry,
  projectConflict,
  progressPatch,
} from "./file-job-handlers.js";
import { readFileLimits } from "./file-limits.js";
import { FileUploadStore } from "./file-upload-store.js";

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
    this.db.exec(trashItemSchema);
    this.uploads = new FileUploadStore(this);
    this.db
      .prepare(
        "UPDATE jobs SET status='interrupted', updated_at=? WHERE status IN ('queued','running','waiting_for_conflict','cancelling')",
      )
      .run(now());
    this.prune(now());
  }
  request(scope, operation, { admit } = {}) {
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
      admit?.(id, operation);
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
  listUploadChildren(scope, id, cursor) {
    if (this.getJob(scope, id).kind !== "upload_group" || !this.uploads.group(id))
      throw fileProblem("FILE_INVALID_OPERATION", 409);
    const collection = `upload-children:${id}`;
    const after = cursorValue(cursor, scope, collection);
    const rows = this.db
      .prepare(
        `
      SELECT e.sequence, e.id AS manifest_entry_id,
        c.id, c.scope_id, c.kind, c.status, c.document
      FROM job_entries e LEFT JOIN jobs c
        ON c.id=json_extract(e.document,'$.currentJobId')
        AND c.scope_id=? AND c.parent_job_id=e.job_id AND c.entry_id=e.id
        AND ((json_extract(e.document,'$.type')='file' AND c.kind='upload')
          OR (json_extract(e.document,'$.type')='directory' AND c.kind='create_directory'))
      WHERE e.job_id=? AND e.sequence>?
        AND json_type(e.document,'$.currentJobId')='text'
        AND json_extract(e.document,'$.currentJobId')!=''
      ORDER BY e.sequence LIMIT 201
    `,
      )
      .all(scope.id, id, after);
    return page(rows, scope, collection, "children", (row) => ({
      entryId: row.manifest_entry_id,
      job: row.id ? publicJob(row) : null,
    }));
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
  transferRows(jobId, transferId) {
    return this.db
      .prepare(
        "SELECT document FROM job_entries WHERE job_id=? AND json_extract(document,'$.transferId')=?",
      )
      .all(jobId, transferId)
      .map((row) => JSON.parse(row.document));
  }
  bindTransfer(scope, jobId, transferId, target) {
    if (transferId === undefined) return;
    const job = this.getJob(scope, jobId),
      rows = this.transferRows(jobId, transferId);
    const root = rows.find((row) => row.relativePath === "");
    if (
      !["copy", "move"].includes(job.kind) ||
      typeof transferId !== "string" ||
      !root ||
      root.path !== target ||
      rows.some(
        (row) =>
          !/^\d+:\d+$/.test(row.identity) ||
          row.path !== path.join(target, row.relativePath),
      )
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
  }
  refreshTransferProgress(jobId) {
    const rows = this.db
      .prepare("SELECT document FROM job_entries WHERE job_id=?")
      .all(jobId)
      .map((row) => JSON.parse(row.document));
    const job = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
    const completed = rows.filter(
      (row) => row.outputPublished && (job.kind !== "move" || row.sourceRemoved),
    );
    this.transition(jobId, job.status, job.status, {
      completedEntries: completed.length,
      completedBytes: completed.reduce(
        (n, row) => n + (row.type === "file" ? row.size : 0),
        0,
      ),
    });
    return {
      completed: completed.length,
      published: rows.filter((row) => row.outputPublished).length,
    };
  }
  checkpointTransferEntry(jobId, row, publication) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.putEntry(jobId, row);
      this.refreshTransferProgress(jobId);
      if (publication) {
        if (publication.jobId !== jobId) throw fileProblem("FILE_INVALID_OPERATION", 400);
        this.putPublication(publication);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  completeTransfer(record, revision, revisions = new Map()) {
    if (record.document.upload) return this.uploads.complete(record, revision);
    const { transferId } = record.document;
    if (!transferId || record.document.transferCompleted) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const move = this.getOperation(record.jobId).kind === "move";
      for (const row of this.transferRows(record.jobId, transferId)) {
        if (row.type === "special") continue;
        row.outputPublished = true;
        row.sourceRemoved ||= Boolean(record.document.renameSource);
        row.status = move && !row.sourceRemoved ? "published" : "completed";
        if (!row.relativePath) row.revision = revision;
        else row.revision = revisions.get(row.id) || null;
        row.name = path.basename(row.path);
        this.putEntry(record.jobId, row);
      }
      this.refreshTransferProgress(record.jobId);
      const document = { ...record.document, transferCompleted: true };
      this.putPublication({ ...record, document });
      this.db.exec("COMMIT");
      Object.assign(record.document, document);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
  deleteTrash(id) {
    this.db.prepare("DELETE FROM trash_entries WHERE id=?").run(id);
  }
  clearTrashItems(id) {
    this.db.prepare("DELETE FROM trash_items WHERE trash_id=?").run(id);
  }
  putTrashItem(id, relativePath, document) {
    if (
      typeof relativePath !== "string" ||
      relativePath.length > 4096 ||
      Buffer.byteLength(JSON.stringify(document)) > 65536
    )
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    const count = this.db
      .prepare("SELECT count(*) AS n FROM trash_items WHERE trash_id=?")
      .get(id).n;
    if (
      count >= this.limits.jobEntries &&
      !this.db
        .prepare("SELECT 1 FROM trash_items WHERE trash_id=? AND path=?")
        .get(id, relativePath)
    )
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    this.db
      .prepare(
        "INSERT INTO trash_items VALUES(?,?,?) ON CONFLICT(trash_id,path) DO UPDATE SET document=excluded.document",
      )
      .run(id, relativePath, JSON.stringify(document));
  }
  trashItems(id) {
    return this.db
      .prepare("SELECT document FROM trash_items WHERE trash_id=? ORDER BY rowid")
      .all(id)
      .map((row) => JSON.parse(row.document));
  }
  listTrashRecords(scope, cursor) {
    const after = cursorValue(cursor, scope, "trash");
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence,json_remove(document,'$.sourceManifest','$.payloadManifest') AS document FROM trash_entries WHERE rowid>? AND (?='global' OR substr(json_extract(document,'$.originalAbsolute'),1,length(?)+1)=?||'/') ORDER BY rowid LIMIT 201`,
      )
      .all(after, scope.kind, scope.root || "/", scope.root || "/");
    return page(rows, scope, "trash", "entries", (row) => JSON.parse(row.document));
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
