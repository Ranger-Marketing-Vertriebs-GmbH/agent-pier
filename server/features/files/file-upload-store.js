import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileProblem } from "./file-errors.js";
import { terminalStates } from "./file-schema.js";
import {
  uploadNamePolicy,
  uploadNameKey,
  uploadRelativePath,
  uploadId,
  uploadHash,
} from "./file-upload-names.js";

const schema = `
CREATE TABLE IF NOT EXISTS upload_groups(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS upload_batches(group_id TEXT NOT NULL REFERENCES upload_groups(job_id) ON DELETE CASCADE, batch_id TEXT NOT NULL, hash TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(group_id,batch_id));
CREATE TABLE IF NOT EXISTS uploads(job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS upload_entries_path ON job_entries(job_id,json_extract(document,'$.relativePath'));
CREATE INDEX IF NOT EXISTS upload_entries_identity ON job_entries(job_id,json_extract(document,'$.identity'));
`;
export class FileUploadStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(schema);
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
  get(table, id) {
    const row = this.db.prepare(`SELECT document FROM ${table} WHERE job_id=?`).get(id);
    return row ? JSON.parse(row.document) : null;
  }
  save(table, id, doc) {
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET document=excluded.document`,
      )
      .run(id, JSON.stringify(doc));
  }
  group(id) {
    return this.get("upload_groups", id);
  }
  attempt(id) {
    return this.get("uploads", id);
  }
  hasRequest(scope, requestId) {
    return (
      typeof requestId === "string" &&
      Boolean(
        this.db
          .prepare("SELECT 1 FROM requests WHERE scope_id=? AND request_id=?")
          .get(scope.id, requestId),
      )
    );
  }
  rows(id) {
    return this.db
      .prepare("SELECT document FROM job_entries WHERE job_id=? ORDER BY sequence")
      .all(id)
      .map((row) => JSON.parse(row.document));
  }
  rowByPath(id, relativePath) {
    const row = this.db
      .prepare(
        "SELECT document FROM job_entries WHERE job_id=? AND json_extract(document,'$.relativePath')=?",
      )
      .get(id, relativePath);
    return row ? JSON.parse(row.document) : null;
  }
  directoryAlias(id, rowId, identity) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM job_entries WHERE job_id=? AND id!=? AND json_extract(document,'$.identity')=? LIMIT 1",
        )
        .get(id, rowId, identity),
    );
  }
  createGroup(id) {
    this.save("upload_groups", id, {
      committed: false,
      policy: uploadNamePolicy,
      generation: 0,
      attemptedBytes: 0,
      lastActivity: this.store.now(),
      cancelled: false,
    });
  }
  touch(id) {
    const group = this.group(id);
    if (!group) return;
    group.generation++;
    group.lastActivity = this.store.now();
    this.save("upload_groups", id, group);
  }
  append(scope, id, batch) {
    const job = this.store.getJob(scope, id),
      group = this.group(id);
    if (
      !group ||
      job.kind !== "upload_group" ||
      !batch ||
      Object.keys(batch).some((key) => !["batchId", "entries"].includes(key)) ||
      !Array.isArray(batch.entries) ||
      !batch.entries.length
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    uploadId(batch.batchId);
    if (Buffer.byteLength(JSON.stringify(batch)) > 60 * 1024)
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    const hash = uploadHash(batch.entries);
    const prior = this.db
      .prepare("SELECT * FROM upload_batches WHERE group_id=? AND batch_id=?")
      .get(id, batch.batchId);
    if (prior) {
      if (prior.hash !== hash) throw fileProblem("FILE_REQUEST_CONFLICT", 409);
      return JSON.parse(prior.receipt);
    }
    if (group.committed || group.cancelled || group.policy !== uploadNamePolicy)
      throw fileProblem("FILE_INVALID_OPERATION", 409);
    let result;
    try {
      result = this.transaction(() => {
        const rows = this.rows(id),
          byPath = new Map(rows.map((row) => [row.relativePath, row]));
        const ids = new Set(rows.map((row) => row.id));
        const aliases = new Map(rows.map((row) => [row.alias, row.relativePath]));
        const changed = new Map(),
          removed = new Set();
        const root = group.destinationPath,
          limits = this.store.limits;
        for (const entry of batch.entries) {
          if (
            !entry ||
            Object.keys(entry).some(
              (key) => !["id", "relativePath", "type", "bytes"].includes(key),
            ) ||
            !["file", "directory"].includes(entry.type) ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 ||
            (entry.type === "directory" && entry.bytes !== 0)
          )
            throw fileProblem("FILE_INVALID_OPERATION", 400);
          uploadId(entry.id);
          if (entry.bytes > limits.uploadBytes)
            throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
          const parts = uploadRelativePath(entry.relativePath, limits);
          const keys = parts.map(uploadNameKey);
          for (let count = 1; count <= parts.length; count++) {
            const relativePath = parts.slice(0, count).join("/"),
              leaf = count === parts.length;
            const alias = keys.slice(0, count).join("/");
            const existing = byPath.get(relativePath);
            if (aliases.has(alias) && aliases.get(alias) !== relativePath)
              throw fileProblem("FILE_UPLOAD_ALIAS", 409);
            if (existing) {
              if (
                existing.type !== "directory" ||
                (leaf && (entry.type !== "directory" || !existing.implicit))
              )
                throw fileProblem("FILE_UPLOAD_ALIAS", 409);
              if (leaf) {
                if (ids.has(entry.id)) throw fileProblem("FILE_UPLOAD_ALIAS", 409);
                removed.add(existing.id);
                changed.delete(existing.id);
                ids.delete(existing.id);
                existing.id = entry.id;
                existing.implicit = false;
                ids.add(entry.id);
                changed.set(existing.id, existing);
              }
              continue;
            }
            const row = {
              id: leaf ? entry.id : randomUUID(),
              relativePath,
              path: path.join(root, relativePath),
              name: parts[count - 1],
              type: leaf ? entry.type : "directory",
              bytes: leaf ? entry.bytes : 0,
              completedBytes: 0,
              status: "pending",
              implicit: !leaf,
              alias,
            };
            if (ids.has(row.id)) throw fileProblem("FILE_UPLOAD_ALIAS", 409);
            ids.add(row.id);
            aliases.set(alias, relativePath);
            byPath.set(relativePath, row);
            if (byPath.size > limits.jobEntries)
              throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
            changed.set(row.id, row);
          }
        }
        const entries = [...byPath.values()],
          totalBytes = entries.reduce((sum, row) => sum + row.bytes, 0);
        if (totalBytes > limits.jobBytes) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
        // Validate the bounded final set before writing this batch. Avoid a full
        // job row count for every individual insertion in a 50,000-entry group.
        for (const removedId of removed)
          this.db
            .prepare("DELETE FROM job_entries WHERE job_id=? AND id=?")
            .run(id, removedId);
        const upsert = this.db.prepare(
          "INSERT INTO job_entries(job_id,id,document) VALUES(?,?,?) ON CONFLICT(job_id,id) DO UPDATE SET document=excluded.document",
        );
        for (const row of changed.values()) {
          const document = JSON.stringify(row);
          if (Buffer.byteLength(document) > 64 * 1024)
            throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
          upsert.run(id, row.id, document);
        }
        this.store.transition(id, job.status, job.status, {
          totalEntries: entries.length,
          totalBytes,
        });
        this.touch(id);
        const receipt = {
          batchId: batch.batchId,
          totalEntries: entries.length,
          totalBytes,
        };
        this.db
          .prepare("INSERT INTO upload_batches VALUES(?,?,?,?)")
          .run(id, batch.batchId, hash, JSON.stringify(receipt));
        return receipt;
      });
    } catch (error) {
      if (error.code === "FILE_LIMIT_EXCEEDED") {
        this.save("upload_groups", id, {
          ...group,
          invalid: true,
          lastActivity: this.store.now(),
        });
      }
      throw error;
    }
    return result;
  }
  assertRetryable(scope, row, owns) {
    const id = row.currentJobId;
    if (!id) return;
    if (owns(id) || this.unresolved(id)) throw fileProblem("FILE_UPLOAD_PENDING", 409);
    // Retention may remove a terminal child while its unfinished parent keeps
    // the disposition. Absence never overrides a live owner or publication pin.
    if (!this.store.getOperation(id)) {
      if (!["failed", "cancelled", "interrupted"].includes(row.status))
        throw fileProblem("FILE_UPLOAD_PENDING", 409);
      return;
    }
    if (!terminalStates.includes(this.store.getJob(scope, id).status))
      throw fileProblem("FILE_UPLOAD_PENDING", 409);
  }
  claim(scope, id, operation, owns = () => false) {
    const { bytes } = operation.options;
    if (operation.parentJobId) {
      const groupId = operation.parentJobId,
        group = this.group(groupId),
        row = this.store.getEntry(groupId, operation.entryId);
      const parent = this.store.getJob(scope, groupId);
      if (
        !group?.committed ||
        group.invalid ||
        parent.status === "completed" ||
        !row ||
        row.type !== "file" ||
        ["completed", "skipped"].includes(row.status) ||
        row.bytes !== bytes ||
        row.path !== path.join(operation.target, operation.name)
      )
        throw fileProblem("FILE_INVALID_OPERATION", 409);
      this.assertRetryable(scope, row, owns);
      group.cancelled = false;
      this.save("upload_groups", groupId, group);
      this.store.putEntry(groupId, {
        ...row,
        currentJobId: id,
        status: "queued",
        completedBytes: 0,
        issue: null,
      });
      this.store.transition(groupId, parent.status, parent.status, {
        completedBytes: Math.max(0, parent.completedBytes - (row.completedBytes || 0)),
      });
      for (
        let ancestor = path.dirname(row.relativePath);
        ancestor !== ".";
        ancestor = path.dirname(ancestor)
      ) {
        const directory = this.rowByPath(groupId, ancestor);
        if (
          directory &&
          ["failed", "cancelled", "interrupted"].includes(directory.status)
        ) {
          this.assertRetryable(scope, directory, owns);
          this.store.putEntry(groupId, {
            ...directory,
            status: "pending",
            currentJobId: null,
          });
        }
      }
      this.touch(groupId);
    }
    this.save("uploads", id, {
      bytes,
      received: 0,
      lastActivity: this.store.now(),
      groupId: operation.parentJobId || null,
      entryId: operation.entryId || null,
    });
    this.store.putEntry(id, {
      id: "upload",
      path: path.join(operation.target, operation.name),
      type: "file",
      name: operation.name,
      bytes,
      completedBytes: 0,
      status: "queued",
    });
    this.store.transition(id, "queued", "queued", { totalBytes: bytes, totalEntries: 1 });
  }
  unresolved(id) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM publications WHERE job_id=? AND phase!='resolved' LIMIT 1",
        )
        .get(id),
    );
  }
  updateRow(id, patch) {
    const upload = this.attempt(id);
    this.store.putEntry(id, { ...this.store.getEntry(id, "upload"), ...patch });
    if (upload?.groupId) {
      const row = this.store.getEntry(upload.groupId, upload.entryId);
      if (row?.currentJobId === id)
        this.store.putEntry(upload.groupId, { ...row, ...patch, id: row.id });
    }
  }
  settle(scope, id, status, issue = null) {
    this.transaction(() => {
      const upload = this.attempt(id),
        job = this.store.getJob(scope, id);
      if (upload.published || upload.completed)
        throw fileProblem("FILE_UPLOAD_PENDING", 409);
      upload.skipped = status === "skipped";
      upload.lastActivity = this.store.now();
      this.save("uploads", id, upload);
      this.updateRow(id, { status, issue });
      this.store.transition(id, job.status, upload.skipped ? "completed" : status, {
        issue,
      });
      if (upload.groupId) this.touch(upload.groupId);
    });
  }
  refresh(id) {
    const rows = this.rows(id),
      job = this.db.prepare("SELECT status FROM jobs WHERE id=?").get(id);
    this.store.transition(id, job.status, job.status, {
      completedEntries: rows.filter((row) => row.status === "completed").length,
      completedBytes: rows.reduce((sum, row) => sum + (row.completedBytes || 0), 0),
    });
  }
  charge(scope, id, bytes) {
    return this.transaction(() => {
      const job = this.store.getJob(scope, id),
        upload = this.attempt(id),
        limits = this.store.limits;
      if (job.status !== "running" || !upload || upload.published)
        throw fileProblem("FILE_UPLOAD_PENDING", 409);
      const received = upload.received + bytes;
      if (
        received > upload.bytes ||
        received > limits.uploadBytes ||
        received > limits.jobBytes
      )
        throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      if (upload.groupId) {
        const group = this.group(upload.groupId);
        if (group.cancelled) throw fileProblem("FILE_CANCELLED", 409);
        if (group.attemptedBytes + bytes > limits.jobBytes)
          throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
        group.attemptedBytes += bytes;
        group.lastActivity = this.store.now();
        this.save("upload_groups", upload.groupId, group);
      }
      upload.received = received;
      upload.lastActivity = this.store.now();
      this.save("uploads", id, upload);
      this.updateRow(id, { completedBytes: received, status: "running" });
      this.store.transition(id, "running", "running", { completedBytes: received });
      if (upload.groupId) {
        const parent = this.store.getJob(scope, upload.groupId);
        this.store.transition(upload.groupId, parent.status, parent.status, {
          completedBytes: parent.completedBytes + bytes,
        });
      }
      return received;
    });
  }
  bind(scope, id, target) {
    const job = this.store.getJob(scope, id),
      upload = this.attempt(id),
      op = this.store.getOperation(id);
    if (
      job.kind !== "upload" ||
      !upload ||
      upload.publicationId ||
      (upload.path || path.join(op.target, op.name)) !== target
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    return {
      id,
      scopeId: scope.id,
      bytes: upload.bytes,
      groupId: upload.groupId,
      entryId: upload.entryId,
    };
  }
  publication(id, publicationId) {
    const upload = this.attempt(id);
    if (!upload || (upload.publicationId && upload.publicationId !== publicationId))
      throw fileProblem("FILE_UPLOAD_PENDING", 409);
    upload.publicationId = publicationId;
    this.save("uploads", id, upload);
  }
  complete(record, revision) {
    const binding = record.document.upload;
    if (!binding || record.document.uploadCompleted) return;
    const upload = this.attempt(record.jobId);
    const proof = record.document.uploadProof;
    if (
      !upload ||
      binding.id !== record.jobId ||
      upload.publicationId !== record.id ||
      !proof ||
      !/^[a-f0-9]{64}$/.test(proof.hash) ||
      proof.bytes !== upload.bytes ||
      binding.bytes !== upload.bytes ||
      binding.scopeId !== upload.scope.id ||
      binding.groupId !== upload.groupId ||
      binding.entryId !== upload.entryId ||
      upload.received !== binding.bytes ||
      record.document.uploadChanged
    )
      throw fileProblem("FILE_UPLOAD_PENDING", 409);
    this.store.getJob(upload.scope, record.jobId);
    if (
      upload.groupId &&
      this.store.getEntry(upload.groupId, upload.entryId)?.currentJobId !== record.jobId
    )
      throw fileProblem("FILE_UPLOAD_PENDING", 409);
    const document = { ...record.document, uploadCompleted: true };
    this.transaction(() => {
      upload.published = true;
      this.save("uploads", record.jobId, upload);
      this.updateRow(record.jobId, {
        outputPublished: true,
        status: "published",
        revision,
        path: record.document.selectedPath,
      });
      this.store.putPublication({ ...record, document });
      if (upload.groupId) this.touch(upload.groupId);
    });
    Object.assign(record.document, document);
  }
  finish(scope, id) {
    const upload = this.attempt(id);
    if (!upload?.published || this.unresolved(id)) return false;
    this.transaction(() => {
      upload.completed = true;
      this.save("uploads", id, upload);
      this.updateRow(id, { status: "completed", completedBytes: upload.bytes });
      const job = this.store.getJob(scope, id);
      this.store.transition(id, job.status, "completed", {
        completedEntries: 1,
        completedBytes: upload.bytes,
        issue: null,
      });
      if (upload.groupId) {
        this.refresh(upload.groupId);
        this.touch(upload.groupId);
      }
    });
    return true;
  }
  page(table, after = "", limit = 200) {
    return this.db
      .prepare(
        `SELECT job_id,document FROM ${table} WHERE job_id>? ORDER BY job_id LIMIT ?`,
      )
      .all(after, limit)
      .map((row) => ({ id: row.job_id, ...JSON.parse(row.document) }));
  }
}
