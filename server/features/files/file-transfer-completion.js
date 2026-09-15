import { resolveFile, entryRevision } from "./file-paths.js";
import { inodeIdentity, contentIdentity } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";
import { scanTree } from "./file-tree.js";
import { extractRevisions } from "./file-extract-stage.js";

export async function assertRenamedTransfer(publisher, state) {
  if (!state.document.transferId) return;
  const rows = publisher.store.transferRows(state.jobId, state.document.transferId);
  const actual = await scanTree(publisher.native, state.parentHandle, state.name, {
    limits: publisher.store.limits,
  });
  if (actual.length !== rows.length) throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  for (const row of actual) {
    const expected = rows.find((item) => item.relativePath === row.relativePath);
    if (
      !expected ||
      row.identity !== expected.identity ||
      (row.relativePath
        ? row.revision !== expected.revision
        : row.content !== expected.content)
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  }
}

// Filesystem observations remain outside the short database/namespace barrier.
export async function transferRevisions(store, record, native) {
  const doc = record.document;
  if (doc.extract) return extractRevisions(store, record, native);
  if (!doc.transferId || doc.transferCompleted) return new Map();
  const revisions = new Map();
  for (const row of store.transferRows(record.jobId, doc.transferId)) {
    if (row.type === "special") continue;
    const selected = await resolveFile(doc.scope, row.path, { followLeaf: false });
    if (
      inodeIdentity(selected.stat) !==
      (doc.renameSource ? row.identity : row.targetIdentity)
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    if (
      row.relativePath &&
      entryRevision(selected.stat) !==
        (doc.renameSource ? row.revision : row.targetRevision)
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    if (
      !row.relativePath &&
      doc.renameSource &&
      contentIdentity(selected.stat) !== row.content
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    revisions.set(row.id, entryRevision(selected.stat, selected.linkIdentity));
  }
  return revisions;
}
