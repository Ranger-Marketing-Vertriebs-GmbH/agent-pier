import path from "node:path";
import { fileProblem } from "./file-errors.js";
import { resolveFile, assertFileMutationTarget, entryRevision } from "./file-paths.js";
import {
  openParent,
  ownedHandle,
  sameInode,
  inodeIdentity,
  publicationSnapshot,
} from "./file-stage.js";

const conflict = () => fileProblem("FILE_CONFLICT_CHANGED", 409);
export async function assertPublicationExpected(
  publisher,
  scope,
  selectedPath,
  revision,
  { followLeaf = false, expectedTarget } = {},
) {
  if (publisher.barrier.hasLease() || publisher.locks.hasLease())
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  const fresh = await resolveFile(scope, selectedPath, {
    followLeaf,
    allowMissingLeaf: true,
  });
  assertFileMutationTarget(scope, fresh);
  if (expectedTarget && expectedTarget !== fresh.absolute) throw conflict();
  if (revision === null) {
    if (fresh.stat) throw conflict();
    return fresh;
  }
  if (
    typeof revision !== "string" ||
    !/^(e1|d1):[a-f0-9]{64}$/.test(revision) ||
    !fresh.stat
  )
    throw conflict();
  let actual;
  if (revision.startsWith("e1:")) actual = entryRevision(fresh.stat, fresh.linkIdentity);
  else {
    const parent = await openParent(publisher.native, fresh.absolute);
    let handle;
    try {
      handle = ownedHandle(
        publisher.native,
        await publisher.native.run("openFile", {
          directory: parent.handle,
          path: path.basename(fresh.absolute),
        }),
      );
      if (!sameInode(await handle.stat(), inodeIdentity(fresh.stat))) throw conflict();
      const snapshot = await publicationSnapshot(handle, fresh.linkIdentity);
      actual = snapshot.revision;
      fresh.publicationContentRevision = snapshot.publicationContentRevision;
    } finally {
      await handle?.close();
      await parent.close();
    }
  }
  if (actual !== revision) throw conflict();
  return fresh;
}
