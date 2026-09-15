import { fileProblem } from "./file-errors.js";

export function extractRows(store, jobId, stageId, role = "output") {
  const key = role === "probe" ? "extractProbe" : "extractGroup";
  return store.db
    .prepare(
      `SELECT document FROM job_entries WHERE job_id=? AND json_extract(document,'$.${key}')=?`,
    )
    .all(jobId, stageId)
    .map((row) => JSON.parse(row.document));
}

export function bindExtract(store, scope, jobId, target, binding) {
  const job = store.getJob(scope, jobId),
    operation = store.getOperation(jobId);
  const row = store.getEntry(jobId, binding?.rootId);
  if (
    job.kind !== "extract" ||
    operation.sources.length !== 1 ||
    !["output", "probe"].includes(binding?.role) ||
    !row ||
    row.path !== target ||
    typeof binding.group !== "string" ||
    !binding.group
  )
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  return {
    version: 1,
    role: binding.role,
    rootId: row.id,
    group: binding.group,
    scopeId: scope.id,
    target,
  };
}

export function completeExtract(store, record, revision, revisions) {
  const doc = record.document,
    binding = doc.extract;
  if (
    binding?.role !== "output" ||
    !doc.extractValidated ||
    binding.scopeId !== doc.scopeId ||
    store.getOperation(record.jobId)?.kind !== "extract"
  )
    throw fileProblem("FILE_INTERRUPTED", 409);
  if (doc.extractCompleted) return;
  const rows = extractRows(store, record.jobId, binding.group);
  if (
    !rows.length ||
    rows.some(
      (row) =>
        row.payload?.stageId !== record.id ||
        row.payload.phase !== "verified" ||
        !revisions.has(row.id),
    )
  )
    throw fileProblem("FILE_INTERRUPTED", 409);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows)
      store.putEntry(record.jobId, {
        ...row,
        status: "completed",
        outputPublished: true,
        name: row.effectiveName,
        revision: row.id === binding.rootId ? revision : revisions.get(row.id),
      });
    store.refreshTransferProgress(record.jobId);
    store.putPublication({ ...record, document: { ...doc, extractCompleted: true } });
    store.db.exec("COMMIT");
    doc.extractCompleted = true;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

export function extractCheckpoint(publisher, jobId, row, patch) {
  return publisher.barrier.run(() => {
    const current = publisher.store.getEntry(jobId, row.id);
    publisher.store.putEntry(jobId, { ...current, ...patch });
    Object.assign(row, patch);
  });
}
