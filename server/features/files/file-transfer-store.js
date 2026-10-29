// The copy and move transfers of a file job (FileStore delegates): the result rows of
// one transfer, its binding to a target, its progress and its completion.
import path from "node:path";
import { appendFilePath } from "./file-paths.js";
import { completeExtract } from "./file-extract-store.js";
import { fileProblem } from "./file-errors.js";
export function transferRows(store, jobId, transferId) {
  return store.db
    .prepare(
      "SELECT document FROM job_entries WHERE job_id=? AND json_extract(document,'$.transferId')=?",
    )
    .all(jobId, transferId)
    .map((row) => JSON.parse(row.document));
}

export function bindTransfer(store, scope, jobId, transferId, target) {
  if (transferId === undefined) return;
  const job = store.getJob(scope, jobId),
    rows = store.transferRows(jobId, transferId);
  const root = rows.find((row) => row.relativePath === "");
  if (
    !["copy", "move"].includes(job.kind) ||
    typeof transferId !== "string" ||
    !root ||
    root.path !== target ||
    rows.some(
      (row) =>
        !/^\d+:\d+$/.test(row.identity) ||
        row.path !== appendFilePath(target, row.relativePath),
    )
  )
    throw fileProblem("FILE_INVALID_OPERATION", 400);
}

export function refreshTransferProgress(store, jobId) {
  const rows = store.db
    .prepare("SELECT document FROM job_entries WHERE job_id=?")
    .all(jobId)
    .map((row) => JSON.parse(row.document));
  const job = store.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  const completed = rows.filter(
    (row) => row.outputPublished && (job.kind !== "move" || row.sourceRemoved),
  );
  store.transition(jobId, job.status, job.status, {
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

export function checkpointTransferEntry(store, jobId, row, publication) {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.putEntry(jobId, row);
    store.refreshTransferProgress(jobId);
    if (publication) {
      if (publication.jobId !== jobId) throw fileProblem("FILE_INVALID_OPERATION", 400);
      store.putPublication(publication);
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function completeTransfer(
  store,
  record,
  revision,
  revisions = new Map(),
  observation = null,
) {
  if (record.document.textSave) return store.text.complete(record, observation);
  if (record.document.extract) return completeExtract(store, record, revision, revisions);
  if (record.document.upload) return store.uploads.complete(record, revision);
  if (record.document.archive) return store.archives.complete(record, revision);
  const { transferId } = record.document;
  if (!transferId || record.document.transferCompleted) return;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const move = store.getOperation(record.jobId).kind === "move";
    for (const row of store.transferRows(record.jobId, transferId)) {
      if (row.type === "special") continue;
      row.outputPublished = true;
      row.sourceRemoved ||= Boolean(record.document.renameSource);
      row.status = move && !row.sourceRemoved ? "published" : "completed";
      if (!row.relativePath) row.revision = revision;
      else row.revision = revisions.get(row.id) || null;
      row.name = path.basename(row.path);
      store.putEntry(record.jobId, row);
    }
    store.refreshTransferProgress(record.jobId);
    const document = { ...record.document, transferCompleted: true };
    store.putPublication({ ...record, document });
    store.db.exec("COMMIT");
    Object.assign(record.document, document);
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
