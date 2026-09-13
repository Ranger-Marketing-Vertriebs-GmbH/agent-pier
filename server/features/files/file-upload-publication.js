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
} from "./file-stage.js";

async function changedUpload(publisher, state) {
  await publisher.barrier.run(() => {
    state.document.uploadChanged = true;
    const record = publisher.store.getPublication(state.id);
    publisher.store.putPublication({ ...record, document: state.document });
  });
  throw fileProblem("FILE_UPLOAD_CHANGED", 409);
}

export async function uploadSnapshot(publisher, state) {
  const snapshot = await publicationSnapshot(state.handle);
  if (state.document.upload && snapshot.hash !== state.document.uploadProof?.hash)
    await changedUpload(publisher, state);
  return snapshot;
}

export async function checkpointUpload(publisher, state, hash) {
  if (!state?.document.upload || state.busy || state.finished)
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  let uploadProof;
  if (hash !== undefined) {
    await state.handle.sealWrites();
    await state.handle.sync();
    const observed = await publicationSnapshot(state.handle);
    if (
      observed.hash !== hash ||
      Number((await state.handle.stat()).size) !== state.document.upload.bytes
    )
      await changedUpload(publisher, state);
    uploadProof = { hash, bytes: state.document.upload.bytes };
  }
  const stat = await state.handle.stat();
  if (inodeIdentity(stat) !== state.document.stagedIdentity || stat.type !== "file")
    await changedUpload(publisher, state);
  const patch = {
    uploadPartialRevision: entryRevision(stat),
    ...(uploadProof ? { uploadProof } : {}),
  };
  await publisher.barrier.run(() => {
    Object.assign(state.document, patch);
    publisher.store.putPublication({
      id: state.id,
      jobId: state.jobId,
      phase: "staging",
      document: state.document,
    });
  });
}

/** Registered staging-only cleanup. The final unlink remains prechecked pathname removal. */
export async function discardUploadPayload(publisher, record) {
  const doc = record?.document;
  if (
    !doc?.upload ||
    doc.uploadChanged ||
    !["staging", "interrupted"].includes(record.phase) ||
    !doc.uploadPartialRevision ||
    !doc.stagedIdentity ||
    !doc.stageParent ||
    !doc.targetParent ||
    Object.hasOwn(doc, "expectedIdentity") ||
    doc.uploadCompleted ||
    doc.renameSource ||
    publisher.store.getTrash(record.id)
  )
    throw fileProblem("FILE_UPLOAD_PENDING", 409);
  let parent, targetParent;
  try {
    parent = await openParent(publisher.native, doc.staged);
    targetParent = await openParent(publisher.native, doc.target);
    if (
      inodeIdentity(await parent.stat()) !== doc.stageParent ||
      inodeIdentity(await targetParent.stat()) !== doc.targetParent
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
    await publisher.locks.withPaths([doc.target], () =>
      publisher.barrier.run(async () => {
        const freshRecord = publisher.store.getPublication(record.id);
        if (
          freshRecord.phase !== record.phase ||
          freshRecord.document.uploadPartialRevision !== doc.uploadPartialRevision ||
          !(await parentMatches(publisher.native, doc.staged, doc.stageParent)) ||
          !(await parentMatches(publisher.native, doc.target, doc.targetParent))
        )
          throw fileProblem("FILE_PATH_CHANGED", 409);
        const target = await inspect(
          publisher.native,
          targetParent.handle,
          path.basename(doc.target),
        );
        const current = await inspect(
          publisher.native,
          parent.handle,
          path.basename(doc.staged),
        );
        if (
          inodeIdentity(target) === doc.stagedIdentity ||
          inodeIdentity(current) !== doc.stagedIdentity ||
          current.type !== "file" ||
          entryRevision(current) !== doc.uploadPartialRevision
        )
          throw fileProblem("FILE_PATH_CHANGED", 409);
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
          document: { ...doc, uploadDiscarded: true },
        });
      }),
    );
  } finally {
    await closeHandles(parent, targetParent);
  }
}
