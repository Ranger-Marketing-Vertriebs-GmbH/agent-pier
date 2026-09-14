import path from "node:path";
import { copyMetadata } from "./file-metadata.js";
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
  { followLeaf = false, expectedTarget, maxBytes } = {},
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
      const snapshot = await publicationSnapshot(handle, fresh.linkIdentity, {
        maxBytes,
      });
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

export function recordPublication(publisher, state, phase, patch = {}) {
  Object.assign(state.document, patch);
  return publisher.barrier.run(() => {
    const write = () =>
      publisher.store.putPublication({
        id: state.id,
        jobId: state.jobId,
        phase,
        document: state.document,
      });
    if (state.document.textSave) return publisher.store.text.register(state, write);
    if (state.document.archive)
      return publisher.store.archives.transaction(() => {
        publisher.store.archives.publication(state.jobId, state.id);
        return write();
      });
    if (!state.document.upload) return write();
    return publisher.store.uploads.transaction(() => {
      publisher.store.uploads.publication(state.jobId, state.id);
      return write();
    });
  });
}

export async function preservePublicationMetadata(native, state, source) {
  const target =
    state.handle ||
    ownedHandle(
      native,
      await native.run("openLink", {
        directory: state.parentHandle.handle,
        path: state.name,
      }),
    );
  try {
    await copyMetadata(source, target, { strictOwnership: true, preserveTimes: true });
  } finally {
    if (!state.handle) await target.close();
  }
}
