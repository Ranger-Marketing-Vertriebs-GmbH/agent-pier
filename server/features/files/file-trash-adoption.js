import path from "node:path";
import { openParent } from "./file-stage.js";
import { assertTree, treeConflict } from "./file-tree.js";
import { openTrashPayload } from "./file-trash-storage.js";

/** Finish the two independent adoption obligations: old-container removal and
 * publication resolution. A durable removed marker never licenses a new unlink. */
export async function completeTrashAdoption(trash, record) {
  if (record.adoptionComplete) {
    if (record.phase !== "recoverable") {
      record.phase = "recoverable";
      await trash.save(record);
    }
    return;
  }
  const old = record.adoptionSource;
  const publication = trash.store.getPublication(record.recoveryId);
  if (
    !old ||
    !publication ||
    publication.document.scopeId !== record.scopeId ||
    publication.document.staged !== old.file ||
    publication.document.stageParent !== old.parentIdentity ||
    publication.document.displacedIdentity !== record.sourceManifest?.[0].identity
  )
    throw treeConflict();
  const source = await openTrashPayload(trash.native, record);
  try {
    await source.assertAuthority();
    await assertTree(trash.native, source.parent, source.name, record.payloadManifest, {
      limits: trash.limits,
    });
    await trash.barrier.run(async () => {
      await source.parent.sync();
      if (!old.containerRemoved) {
        const parent = await openParent(trash.native, path.dirname(old.file));
        try {
          await trash.native.run("removeEntry", {
            directory: parent.handle,
            name: path.basename(path.dirname(old.file)),
            identity: old.parentIdentity,
            type: "directory",
          });
          await parent.sync();
          old.containerRemoved = true;
          await trash.save(record);
        } finally {
          await parent.close();
        }
      }
      if (publication.phase !== "resolved")
        trash.store.putPublication({ ...publication, phase: "resolved" });
      await trash.save({ ...record, adoptionComplete: true, phase: "recoverable" });
      record.adoptionComplete = true;
      record.phase = "recoverable";
    });
  } finally {
    await source.parent.close();
  }
}
