import path from "node:path";
import { fileProblem } from "./file-errors.js";
import { entryRevision } from "./file-paths.js";
import {
  openParent,
  closeHandles,
  inspect,
  inodeIdentity,
  parentMatches,
  publicationSnapshot,
  ownedHandle,
} from "./file-stage.js";

export async function checkpointArchive(
  publisher,
  state,
  proof,
  { signal, validate } = {},
) {
  if (!state?.document.archive || state.busy || state.finished)
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  let final;
  if (proof) {
    state.archiveSignal = signal;
    state.archiveValidate = validate;
    signal?.throwIfAborted();
    await state.handle.sealWrites();
    await state.handle.sync();
    const snapshot = await publicationSnapshot(state.handle, null, { signal });
    const stat = await state.handle.stat();
    if (
      snapshot.hash !== proof.hash ||
      Number(stat.size) !== proof.bytes ||
      proof.bytes > state.document.archive.outputLimit
    ) {
      await publisher.barrier.run(() => {
        state.document.archiveChanged = true;
        publisher.store.putPublication({
          ...publisher.store.getPublication(state.id),
          document: state.document,
        });
      });
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    }
    final = proof;
  }
  const stat = await state.handle.stat();
  if (inodeIdentity(stat) !== state.document.stagedIdentity || stat.type !== "file")
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  await publisher.barrier.run(() => {
    Object.assign(state.document, {
      archivePartialRevision: entryRevision(stat),
      ...(final ? { archiveProof: final } : {}),
    });
    publisher.store.putPublication({
      id: state.id,
      jobId: state.jobId,
      phase: "staging",
      document: state.document,
    });
  });
}
export async function openArchiveArtifact(native, record, signal) {
  const doc = record.document;
  if (
    !doc.archive ||
    doc.archive.mode !== "download" ||
    doc.archiveChanged ||
    !doc.archiveProof ||
    !doc.stagedIdentity ||
    !doc.stageParent ||
    !doc.targetParent
  )
    throw fileProblem("FILE_ARCHIVE_PENDING", 409);
  let parent, targetParent, handle;
  try {
    signal?.throwIfAborted();
    parent = await openParent(native, doc.staged);
    signal?.throwIfAborted();
    targetParent = await openParent(native, doc.target);
    signal?.throwIfAborted();
    if (
      inodeIdentity(await parent.stat()) !== doc.stageParent ||
      inodeIdentity(await targetParent.stat()) !== doc.targetParent
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    signal?.throwIfAborted();
    handle = ownedHandle(
      native,
      await native.run("openFile", {
        directory: parent.handle,
        path: path.basename(doc.staged),
      }),
    );
    signal?.throwIfAborted();
    const stat = await handle.stat();
    if (
      inodeIdentity(stat) !== doc.stagedIdentity ||
      entryRevision(stat) !== doc.archivePartialRevision ||
      Number(stat.size) !== doc.archiveProof.bytes ||
      (await publicationSnapshot(handle, null, { signal })).hash !== doc.archiveProof.hash
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    return { parent, targetParent, handle, stat };
  } catch (error) {
    await closeHandles(handle, parent, targetParent);
    throw error;
  }
}
export async function discardArchivePayload(
  publisher,
  record,
  { artifact = false } = {},
) {
  const doc = record?.document;
  if (
    !doc?.archive ||
    doc.archiveChanged ||
    !doc.archivePartialRevision ||
    !doc.stagedIdentity ||
    !doc.stageParent ||
    !doc.targetParent ||
    doc.renameSource ||
    Object.hasOwn(doc, "expectedIdentity") ||
    (artifact
      ? doc.archive.mode !== "download" || record.phase !== "artifact"
      : doc.archiveCompleted || !["staging", "interrupted"].includes(record.phase))
  )
    throw fileProblem("FILE_ARCHIVE_PENDING", 409);
  let parent, targetParent;
  try {
    parent = await openParent(publisher.native, doc.staged);
    targetParent = await openParent(publisher.native, doc.target);
    await publisher.locks.withPaths([doc.target], () =>
      publisher.barrier.run(async () => {
        const fresh = publisher.store.getPublication(record.id);
        if (
          fresh.phase !== record.phase ||
          fresh.document.archivePartialRevision !== doc.archivePartialRevision ||
          !(await parentMatches(publisher.native, doc.staged, doc.stageParent)) ||
          !(await parentMatches(publisher.native, doc.target, doc.targetParent)) ||
          inodeIdentity(await parent.stat()) !== doc.stageParent ||
          inodeIdentity(await targetParent.stat()) !== doc.targetParent
        )
          throw fileProblem("FILE_CONFLICT_CHANGED", 409);
        const current = await inspect(
          publisher.native,
          parent.handle,
          path.basename(doc.staged),
        );
        if (
          !current ||
          inodeIdentity(current) !== doc.stagedIdentity ||
          current.type !== "file" ||
          entryRevision(current) !== doc.archivePartialRevision
        )
          throw fileProblem("FILE_CONFLICT_CHANGED", 409);
        await publisher.native.run("removeEntry", {
          directory: parent.handle,
          name: path.basename(doc.staged),
          identity: doc.stagedIdentity,
          type: "file",
        });
        await parent.sync();
        await publisher.native.run("removeEntry", {
          directory: targetParent.handle,
          name: path.basename(path.dirname(doc.staged)),
          identity: doc.stageParent,
          type: "directory",
        });
        await targetParent.sync();
        publisher.store.putPublication({
          ...record,
          phase: "resolved",
          document: { ...doc, archiveDiscarded: true },
        });
      }),
    );
  } finally {
    await closeHandles(parent, targetParent);
  }
}
export async function recoverArchiveArtifact({ store, native, record, write }) {
  let opened;
  try {
    const job = store.getJob(record.document.scope, record.jobId);
    if (["cancelled", "failed"].includes(job.status)) return;
    opened = await openArchiveArtifact(native, record);
    await write(() => {
      store.archives.complete(record);
      store.putPublication({ ...record, phase: "artifact" });
      store.archives.finish(record.jobId);
    });
  } catch {
    /* Unproved private bytes remain registered and unavailable. */
  } finally {
    if (opened) await closeHandles(opened.handle, opened.parent, opened.targetParent);
  }
}
export async function archiveSnapshot(publisher, state) {
  const snapshot = await publicationSnapshot(state.handle, null, {
    signal: state.archiveSignal,
  });
  if (
    !state.document.archiveProof ||
    snapshot.hash !== state.document.archiveProof.hash
  ) {
    await publisher.barrier.run(() => {
      state.document.archiveChanged = true;
      publisher.store.putPublication({
        ...publisher.store.getPublication(state.id),
        document: state.document,
      });
    });
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  }
  await state.archiveValidate?.();
  return snapshot;
}
export async function finishArchiveArtifact(publisher, state, { signal, validate }) {
  if (
    !state ||
    state.busy ||
    state.finished ||
    state.document.archive?.mode !== "download"
  )
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  await archiveSnapshot(publisher, state);
  signal.throwIfAborted();
  await publisher.barrier.run(async () => {
    await validate();
    signal.throwIfAborted();
    const record = publisher.store.getPublication(state.id);
    publisher.store.archives.complete(record);
    publisher.store.putPublication({ ...record, phase: "artifact" });
    publisher.store.archives.finish(state.jobId);
  });
}
