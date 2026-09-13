import { resolveFile } from "./file-paths.js";
import path from "node:path";
import { FileNative } from "./file-native.js";
import { fileProblem } from "./file-errors.js";
import {
  openParent,
  inspect,
  sameInode,
  inodeIdentity,
  contentIdentity,
  ownedHandle,
  publicationSnapshot,
} from "./file-stage.js";

/** Startup reconciliation is deliberately non-destructive for uncertain states.
 * A displaced inode stays registered until the trash service durably adopts it.
 * Without a barrier this function is for quiescent startup/direct fixture use. */
export async function recoverPublications({ store, native, barrier }) {
  const records = store
    .listPublications()
    .filter((record) => record.phase !== "resolved");
  if (!records.length) return [];
  const owner = native || new FileNative(),
    outcomes = [];
  const write = (action) => (barrier ? barrier.run(action) : action());
  try {
    for (const record of records) {
      const doc = record.document;
      let targetParent,
        stageParent,
        recorded = false;
      let phase = "interrupted",
        issue = { code: "FILE_INTERRUPTED", args: {} };
      try {
        if (
          doc.version !== 1 ||
          !path.isAbsolute(doc.target) ||
          !path.isAbsolute(doc.staged) ||
          !doc.targetParent ||
          !doc.stageParent ||
          !doc.stagedIdentity
        )
          throw fileProblem("FILE_INTERRUPTED", 409);
        targetParent = await openParent(owner, doc.target);
        stageParent = await openParent(owner, doc.staged);
        if (
          !sameInode(await targetParent.stat(), doc.targetParent) ||
          !sameInode(await stageParent.stat(), doc.stageParent)
        )
          throw fileProblem("FILE_INTERRUPTED", 409);
        const target = await inspect(
          owner,
          targetParent.handle,
          path.basename(doc.target),
        );
        const stage = await inspect(owner, stageParent.handle, path.basename(doc.staged));
        if (
          sameInode(target, doc.stagedIdentity) &&
          Object.hasOwn(doc, "expectedIdentity") &&
          inodeIdentity(stage) === doc.expectedIdentity
        ) {
          const selected = await resolveFile(doc.scope, doc.selectedPath, {
            followLeaf: doc.followLeaf,
          });
          if (
            selected.absolute !== doc.target ||
            !sameInode(selected.stat, doc.stagedIdentity) ||
            (doc.followLeaf && selected.linkIdentity !== doc.linkIdentity)
          )
            throw fileProblem("FILE_INTERRUPTED", 409);
          if (
            doc.issue?.code === "FILE_CONFLICT_CHANGED" ||
            (stage && contentIdentity(stage) !== doc.expectedContent)
          )
            throw fileProblem("FILE_INTERRUPTED", 409);
          for (const [parent, name, revision] of [
            [targetParent, path.basename(doc.target), doc.stagedContentRevision],
            [
              stageParent,
              path.basename(doc.staged),
              stage ? doc.expectedContentRevision : null,
            ],
          ]) {
            if (!revision) continue;
            const handle = ownedHandle(
              owner,
              await owner.run("openFile", { directory: parent.handle, path: name }),
            );
            try {
              if (
                (await publicationSnapshot(handle)).publicationContentRevision !==
                revision
              )
                throw fileProblem("FILE_INTERRUPTED", 409);
            } finally {
              await handle.close();
            }
          }
          // Preparation and hashes precede this short physical lease. Startup
          // can overlap unrelated application snapshots, so disposition and its
          // durable journal update must share the same barrier even on failure.
          await write(async () => {
            try {
              await stageParent.sync();
              await targetParent.sync();
              if (!stage) {
                await owner.run("removeEntry", {
                  directory: targetParent.handle,
                  name: path.basename(path.dirname(doc.staged)),
                  identity: doc.stageParent,
                  type: "directory",
                });
                await targetParent.sync();
              }
              phase = stage ? "swapped" : "resolved";
              issue = null;
              doc.displacedIdentity = inodeIdentity(stage);
            } catch {
              phase = "interrupted";
              issue = { code: "FILE_INTERRUPTED", args: {} };
            }
            store.putPublication({ ...record, phase, document: { ...doc, issue } });
            recorded = true;
          });
        }
      } catch {
        // Missing, replaced or unproven ancestors never authorize replay/delete.
      } finally {
        await stageParent?.close();
        await targetParent?.close();
      }
      if (!recorded)
        await write(() =>
          store.putPublication({ ...record, phase, document: { ...doc, issue } }),
        );
      outcomes.push({
        id: record.id,
        phase,
        recoveryId: phase === "resolved" ? null : record.id,
        issue,
      });
    }
    return outcomes;
  } finally {
    if (!native) await owner.close();
  }
}
