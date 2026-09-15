import path from "node:path";
import {
  openParent,
  inodeIdentity,
  inspect,
  parentMatches,
  closeHandles,
} from "./file-stage.js";
import { scanTree, treeParent } from "./file-tree.js";
import { fileProblem } from "./file-errors.js";
import { entryRevision } from "./file-paths.js";

// Only the publisher's actual WeakMap-owned state enters here. Published output,
// adopted sources and uncheckpointed creations never grant cleanup authority.
export async function discardCopyStage(publisher, state, record) {
  const doc = state.document,
    native = publisher.native;
  if (
    !state.finished ||
    !doc.transferId ||
    doc.renameSource ||
    Object.hasOwn(doc, "displacedIdentity") ||
    doc.transferCompleted
  )
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  let parent, targetParent;
  try {
    parent = await openParent(native, state.file);
    targetParent = await openParent(native, state.target);
    if (
      inodeIdentity(await parent.stat()) !== doc.stageParent ||
      inodeIdentity(await targetParent.stat()) !== doc.targetParent ||
      !(await parentMatches(native, state.file, doc.stageParent)) ||
      !(await parentMatches(native, state.target, doc.targetParent))
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    const entries = publisher.store.transferRows(state.jobId, doc.transferId);
    const rows = await scanTree(native, parent, state.name, {
      limits: publisher.store.limits,
    });
    for (const row of rows) {
      const checkpoint = entries.find((item) => item.relativePath === row.relativePath);
      if (
        !checkpoint ||
        checkpoint.phase !== "verified" ||
        checkpoint.targetIdentity !== row.identity ||
        checkpoint.targetRevision !== row.revision
      )
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    }
    await publisher.locks.withPaths([state.target], async () => {
      for (const row of [...rows].reverse()) {
        const owner = await treeParent(
          native,
          parent,
          state.name,
          row.relativePath,
          rows,
        );
        try {
          await publisher.barrier.run(async () => {
            const current = await inspect(
              native,
              owner.handle,
              row.relativePath ? path.basename(row.relativePath) : state.name,
            );
            if (
              !(await parentMatches(native, state.file, doc.stageParent)) ||
              inodeIdentity(current) !== row.identity ||
              current.type !== row.type ||
              (row.type !== "directory" && entryRevision(current) !== row.revision)
            )
              throw fileProblem("FILE_CONFLICT_CHANGED", 409);
            await native.run("removeEntry", {
              directory: owner.handle,
              name: row.relativePath ? path.basename(row.relativePath) : state.name,
              identity: row.identity,
              type: row.type,
            });
            await owner.sync();
            const checkpoint = entries.find(
              (item) => item.relativePath === row.relativePath,
            );
            publisher.store.putEntry(state.jobId, {
              ...checkpoint,
              cleanupRemoved: true,
            });
          });
        } finally {
          await owner.close();
        }
      }
      await publisher.barrier.run(async () => {
        if (!(await parentMatches(native, state.target, doc.targetParent)))
          throw fileProblem("FILE_CONFLICT_CHANGED", 409);
        await native.run("removeEntry", {
          directory: targetParent.handle,
          name: state.directoryName,
          identity: doc.stageParent,
          type: "directory",
        });
        await targetParent.sync();
        await record(state, "resolved", { copyCleanupComplete: true });
      });
    });
  } finally {
    await closeHandles(parent, targetParent);
  }
}
