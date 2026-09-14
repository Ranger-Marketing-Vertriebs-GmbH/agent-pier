import path from "node:path";
import { fileProblem } from "./file-errors.js";

export class FileArchiveStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }
  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(id) {
    const row = this.db.prepare("SELECT document FROM jobs WHERE id=?").get(id);
    return row ? JSON.parse(row.document).archive : null;
  }
  save(id, archive) {
    this.db
      .prepare(
        "UPDATE jobs SET document=json_set(document,'$.archive',json(?)) WHERE id=?",
      )
      .run(JSON.stringify(archive), id);
  }
  rows(id) {
    return this.db
      .prepare("SELECT document FROM job_entries WHERE job_id=? ORDER BY sequence")
      .all(id)
      .map((row) => JSON.parse(row.document));
  }
  plan(scope, id, plan) {
    if (this.store.getJob(scope, id).kind !== "archive" || this.get(id)?.publicationId)
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    this.transaction(() => {
      this.db.prepare("DELETE FROM job_entries WHERE job_id=?").run(id);
      for (const row of plan.rows) this.store.putEntry(id, row);
      this.save(id, { scope, ...plan, rows: undefined });
    });
  }
  consent(id, version) {
    const archive = this.get(id);
    if (archive?.manifestVersion !== version)
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    archive.consent = version;
    this.save(id, archive);
  }
  bind(scope, id, target) {
    const job = this.store.getJob(scope, id),
      archive = this.get(id),
      op = this.store.getOperation(id);
    if (
      job.kind !== "archive" ||
      !archive ||
      archive.scope.id !== scope.id ||
      archive.mode !== op.options.output ||
      archive.target !== target ||
      archive.publicationId ||
      (archive.omissions && archive.consent !== archive.manifestVersion)
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    return {
      id,
      scopeId: scope.id,
      mode: archive.mode,
      target,
      manifestVersion: archive.manifestVersion,
      consent: archive.consent || null,
      bytes: archive.bytes,
      outputLimit: archive.outputLimit,
    };
  }
  target(scope, id) {
    const archive = this.get(id);
    this.store.getJob(scope, id);
    if (!archive || archive.mode !== "download")
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    return path.join(this.store.storageRoot, `archive-${id}.zip`);
  }
  publication(id, publicationId) {
    const archive = this.get(id);
    if (!archive || (archive.publicationId && archive.publicationId !== publicationId))
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    archive.publicationId = publicationId;
    this.save(id, archive);
  }
  skip(id) {
    this.transaction(() => {
      for (const row of this.rows(id))
        this.store.putEntry(id, { ...row, status: "skipped" });
    });
  }
  complete(record) {
    const doc = record.document,
      binding = doc.archive,
      archive = this.get(record.jobId);
    if (doc.archiveCompleted) return;
    if (
      !archive ||
      !binding ||
      archive.publicationId !== record.id ||
      binding.id !== record.jobId ||
      binding.scopeId !== archive.scope.id ||
      binding.mode !== archive.mode ||
      binding.target !== archive.target ||
      binding.manifestVersion !== archive.manifestVersion ||
      binding.consent !== (archive.consent || null) ||
      !doc.archiveProof ||
      doc.archiveChanged ||
      !/^[a-f0-9]{64}$/.test(doc.archiveProof.hash) ||
      !Number.isSafeInteger(doc.archiveProof.bytes) ||
      doc.archiveProof.bytes < 0 ||
      doc.archiveProof.bytes > archive.outputLimit
    )
      throw fileProblem("FILE_ARCHIVE_PENDING", 409);
    this.store.getJob(archive.scope, record.jobId);
    const document = { ...doc, archiveCompleted: true };
    this.transaction(() => {
      archive.published = true;
      this.save(record.jobId, archive);
      for (const row of this.rows(record.jobId))
        this.store.putEntry(record.jobId, {
          ...row,
          status: row.omitted ? "skipped" : "completed",
          outputPublished: !row.omitted,
        });
      const job = this.store.getJob(archive.scope, record.jobId);
      this.store.transition(record.jobId, job.status, job.status, {
        completedEntries: archive.entries,
        completedBytes: archive.bytes,
      });
      this.store.putPublication({ ...record, document });
    });
    Object.assign(record.document, document);
  }
  finish(id) {
    const archive = this.get(id);
    if (!archive?.published) return false;
    const record = this.store.getPublication(archive.publicationId);
    if (record?.phase !== (archive.mode === "download" ? "artifact" : "resolved"))
      return false;
    const job = this.store.getJob(archive.scope, id);
    if (
      ["cancelled", "cancelling"].includes(job.status) ||
      (archive.mode === "download" && job.status === "failed")
    )
      return false;
    if (archive.completed && job.status === "completed") return true;
    this.transaction(() => {
      archive.completed = true;
      archive.completedAt ||= this.store.now();
      this.save(id, archive);
      this.store.transition(id, job.status, "completed", {
        completedEntries: archive.entries,
        completedBytes: archive.bytes,
        issue: null,
      });
    });
    return true;
  }
  page(after = "", limit = 200) {
    return this.db
      .prepare(
        "SELECT id,document FROM jobs WHERE kind='archive' AND id>? ORDER BY id LIMIT ?",
      )
      .all(after, limit)
      .map((row) => ({ id: row.id, ...JSON.parse(row.document).archive }));
  }
}
