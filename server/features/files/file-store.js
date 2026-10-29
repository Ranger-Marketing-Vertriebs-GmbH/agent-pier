import { FileTextStore } from "./file-text-store.js";
import { FileArchiveStore } from "./file-archive-store.js";
import { publicFileJob } from "./file-job-projection.js";
import * as transfers from "./file-transfer-store.js";
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
// A job's version: its write time, raised past the previous one when the clock has
// not moved on, so every write reads differently.
const nextVersion = (previous, now) => Math.max(Number(previous) + 1, now);
/** Synchronous private journal. Construction recovers before consumers can register work. */
export class FileStore {
  constructor({ dataDir, now = Date.now, limits = readFileLimits() }) {
    this.now = now;
    this.limits = limits;
    this.storageRoot = path.resolve(dataDir, "files");
    this.db = privateDatabase(this.storageRoot, "files.sqlite");
    this.db.exec(fileSchema);
    for (const key of ["extractGroup", "extractProbe"])
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${key}_entries ON job_entries(job_id,json_extract(document,'$.${key}'))`,
      );
    this.db.exec(trashItemSchema);
    this.text = new FileTextStore(this);
    this.uploads = new FileUploadStore(this);
    this.archives = new FileArchiveStore(this);
    // Durable archive/extraction cancellation survives generic startup interruption.
    this.db
      .prepare(
        "UPDATE jobs SET status='cancelled' WHERE kind IN ('archive','extract') AND status='cancelling'",
      )
      .run();
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
      this.jobChanged(scope.id);
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
    return publicFileJob(row, this);
  }
  listJobs(scope, cursor) {
    const after = cursorValue(cursor, scope, "jobs");
    const rows = this.db
      .prepare(
        "SELECT rowid AS sequence,* FROM jobs WHERE scope_id=? AND rowid>? ORDER BY rowid LIMIT 201",
      )
      .all(scope.id, after);
    const result = page(rows, scope, "jobs", "jobs", (row) => publicFileJob(row, this));
    // Additive: only a first page that more jobs follow can leave running ones out.
    const active =
      cursor === undefined || cursor === null
        ? this.activeJobs(scope, rows.at(199)?.sequence)
        : [];
    return active.length ? { ...result, active } : result;
  }
  // The first page's running jobs beyond it (oldest first, at most 50), upload children
  // aside: the explorer follows its jobs from the first page however many came before.
  activeJobs(scope, beyond) {
    if (beyond === undefined) return [];
    const active = jobStates.filter((state) => !terminalStates.includes(state));
    return this.db
      .prepare(
        `SELECT * FROM jobs j WHERE scope_id=? AND rowid>? AND status IN (${active.map(() => "?").join(",")}) AND NOT (kind IN ('upload','create_directory') AND EXISTS(SELECT 1 FROM jobs g WHERE g.id=j.parent_job_id AND g.kind='upload_group')) ORDER BY rowid LIMIT 50`,
      )
      .all(scope.id, beyond, ...active)
      .map((row) => publicFileJob(row, this));
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
        c.id, c.scope_id, c.kind, c.status, c.document, c.updated_at
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
      job: row.id ? publicFileJob(row, this) : null,
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
  jobDetails(id) {
    const row = this.db.prepare("SELECT document FROM jobs WHERE id=?").get(id);
    return row ? JSON.parse(row.document) : null;
  }
  // Private producer context in the existing job journal; never returned by HTTP.
  setJobDetails(id, patch) {
    const document = this.jobDetails(id);
    if (!document) throw fileProblem("FILE_NOT_FOUND", 404);
    this.db
      .prepare("UPDATE jobs SET document=? WHERE id=?")
      .run(JSON.stringify({ ...document, ...patch }), id);
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
      .prepare("SELECT document FROM job_entries WHERE job_id=? AND id=?")
      .get(jobId, entry.id);
    // An unchanged row (recovery on every start) is no new version: the job's prune
    // clock keeps running.
    if (existing?.document === encoded) return;
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
    // A result row is a new version of its job: the explorer reads pages per version.
    this.touchJob(jobId);
  }
  /** Raises the job's version (`updatedAt`) and signals its scope. */
  touchJob(id) {
    const row = this.db
      .prepare("SELECT scope_id,updated_at FROM jobs WHERE id=?")
      .get(id);
    if (!row) return;
    this.db
      .prepare("UPDATE jobs SET updated_at=? WHERE id=?")
      .run(nextVersion(row.updated_at, this.now()), id);
    this.jobChanged(row.scope_id);
  }
  /**
   * Tells `onJobChange` (set by FileJobs) that a job of `scopeId` (null: of any
   * scope) changed. A failing listener is logged; the write it reports stands.
   */
  jobChanged(scopeId) {
    try {
      this.onJobChange?.(scopeId);
    } catch {
      console.error("AgentPier could not report a file job change.");
    }
  }
  getEntry(jobId, id) {
    const row = this.db
      .prepare("SELECT document FROM job_entries WHERE job_id=? AND id=?")
      .get(jobId, id);
    return row ? JSON.parse(row.document) : null;
  }
  transferRows(jobId, transferId) {
    return transfers.transferRows(this, jobId, transferId);
  }
  bindTransfer(scope, jobId, transferId, target) {
    return transfers.bindTransfer(this, scope, jobId, transferId, target);
  }
  refreshTransferProgress(jobId) {
    return transfers.refreshTransferProgress(this, jobId);
  }
  checkpointTransferEntry(jobId, row, publication) {
    return transfers.checkpointTransferEntry(this, jobId, row, publication);
  }
  completeTransfer(record, revision, revisions = new Map(), observation = null) {
    return transfers.completeTransfer(this, record, revision, revisions, observation);
  }
  listEntries(scope, id, cursor) {
    this.getJob(scope, id);
    const version = this.archives.get(id)?.manifestVersion;
    const collection = `entries:${id}${version ? ":" + version : ""}`,
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
    if (from === to && JSON.stringify(doc) === row.document)
      return publicFileJob(row, this);
    const updatedAt = nextVersion(row.updated_at, this.now());
    const result = this.db
      .prepare("UPDATE jobs SET status=?,document=?,updated_at=? WHERE id=? AND status=?")
      .run(to, JSON.stringify(doc), updatedAt, id, from);
    if (!result.changes) return null;
    this.jobChanged(row.scope_id);
    return publicFileJob(
      { ...row, status: to, document: JSON.stringify(doc), updated_at: updatedAt },
      this,
    );
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
    // An archive's envelope (artifactReady) reads its publication.
    const job = this.db.prepare("SELECT scope_id FROM jobs WHERE id=?").get(record.jobId);
    if (job) this.jobChanged(job.scope_id);
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
          // A published text pair still needs its durable final adoption marker.
          `DELETE FROM publications WHERE phase='resolved' AND job_id IN (SELECT id FROM jobs WHERE updated_at<? AND status IN (${terminal})) AND (COALESCE(json_extract(document,'$.textCompleted'),0)!=1 OR EXISTS(SELECT 1 FROM jobs j WHERE j.id=publications.job_id AND json_extract(j.document,'$.textSave.complete')=1))`,
        )
        .run(now - retentionMs);
      // Iteration removes terminal children first; every remaining child conservatively pins its parent.
      let result,
        removed = 0;
      do {
        result = this.db
          .prepare(
            `DELETE FROM jobs WHERE updated_at<? AND status IN (${terminal}) AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM trash_entries t WHERE t.job_id=jobs.id) AND NOT EXISTS(SELECT 1 FROM jobs child WHERE child.parent_job_id=jobs.id)`,
          )
          .run(now - retentionMs);
        removed += result.changes;
      } while (result.changes);
      this.db.exec("COMMIT");
      if (removed) this.jobChanged(null);
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
