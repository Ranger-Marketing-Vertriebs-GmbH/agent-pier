import path from "node:path";
import { openTrashPayload } from "./file-trash-storage.js";
import { scanTree, assertTree, treeConflict } from "./file-tree.js";
import { resolveFile } from "./file-paths.js";
import { inspect, inodeIdentity, parentMatches } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";

/** A retained rename source is already private; register it in place, never recopy. */
export async function retainRenameSource(trash, scope, recoveryId) {
  const publication = trash.store.getPublication(recoveryId);
  const doc = publication?.document,
    source = doc?.renameSource;
  if (
    !publication ||
    publication.phase === "resolved" ||
    doc.scopeId !== scope.id ||
    !source ||
    source.disposition === "restored" ||
    !doc.stageParent ||
    !source.identity
  )
    return null;
  if (
    Object.hasOwn(doc, "displacedIdentity") &&
    doc.displacedIdentity !== source.identity
  )
    return null;
  trash.store.getJob(scope, publication.jobId);
  if (
    doc.version !== 1 ||
    doc.scope?.id !== scope.id ||
    typeof source.path !== "string" ||
    !path.isAbsolute(source.absolute || "") ||
    !path.isAbsolute(doc.staged || "") ||
    !path.isAbsolute(doc.target || "") ||
    !/^e1:[a-f0-9]{64}$/.test(source.revision || "") ||
    !/^\d+:\d+$/.test(source.identity) ||
    !/^\d+:\d+$/.test(source.parentIdentity || "")
  )
    throw treeConflict();
  if (source.disposition === "prepared" && doc.initialIdentity) {
    const initial = await openTrashPayload(trash.native, {
      location: {
        file: doc.staged,
        parentIdentity: doc.stageParent,
        identity: doc.initialIdentity,
      },
    }).catch(() => null);
    try {
      const original = await resolveFile(doc.scope, source.path, {
        followLeaf: false,
      }).catch(() => null);
      if (
        initial &&
        original?.absolute === source.absolute &&
        inodeIdentity(original.stat) === source.identity &&
        (await parentMatches(trash.native, source.absolute, source.parentIdentity))
      ) {
        await initial.assertAuthority();
        return null;
      }
    } finally {
      await initial?.parent.close();
    }
  }
  const prior = trash.store.getTrash(recoveryId);
  if (prior) {
    if (prior.reason !== "interrupted_rename" || prior.scopeId !== scope.id)
      throw treeConflict();
    if (prior.phase !== "rename_pending") return prior.id;
  }
  const location = {
    file: doc.staged,
    parentIdentity: doc.stageParent,
    identity: source.identity,
  };
  const record = prior || {
    id: recoveryId,
    jobId: publication.jobId,
    scopeId: scope.id,
    scope: { ...scope },
    originalAbsolute: source.absolute,
    originalPath: source.path,
    sourceParentIdentity: source.parentIdentity,
    deletedAt: new Date().toISOString(),
    reason: "interrupted_rename",
    type: source.type,
    size: null,
    phase: "rename_pending",
    recoveryId,
    location,
  };
  let opened;
  try {
    // Pending visibility comes only from the stored job/scope/source provenance.
    // It claims neither present bytes nor a usable pathname capability.
    await trash.save(record);
    try {
      opened = await openTrashPayload(trash.native, record);
      await opened.assertAuthority();
    } catch {
      record.issue = { code: "FILE_RENAME_RECOVERY", args: {} };
      await trash.save(record);
      return record.id;
    }
    record.sourceVerified = true;
    const rows = await scanTree(trash.native, opened.parent, opened.name, {
      limits: trash.limits,
    });
    await assertTree(trash.native, opened.parent, opened.name, rows, {
      limits: trash.limits,
    });
    await opened.assertAuthority();
    if (
      inodeIdentity(
        await inspect(trash.native, opened.parent.handle, path.basename(doc.staged)),
      ) !== source.identity
    )
      throw treeConflict();
    record.sourceManifest = rows;
    record.payloadManifest = rows;
    record.size = rows.reduce(
      (total, row) => total + (row.type === "file" ? row.size : 0),
      0,
    );
    record.phase = "recoverable";
    await trash.barrier.run(async () => {
      await opened.parent.sync();
      await trash.save(record);
    });
    return record.id;
  } catch {
    record.phase = "rename_pending";
    record.issue = { code: "FILE_RENAME_RECOVERY", args: {} };
    await trash.save(record);
    throw fileProblem("FILE_RENAME_RECOVERY", 409);
  } finally {
    await opened?.parent.close();
  }
}
