import {
  publicationSnapshot,
  inspect,
  inodeIdentity,
  parentMatches,
} from "./file-stage.js";
import { entryRevision, resolveFile } from "./file-paths.js";
import { fileProblem } from "./file-errors.js";

export async function textStageSnapshot(state) {
  const binding = state.document.textSave;
  const observed = await publicationSnapshot(state.handle, null, {
    maxBytes: binding.bytes,
  });
  if (observed.hash !== binding.hash || observed.bytes !== binding.bytes)
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  state.document.textProof = { hash: observed.hash, bytes: observed.bytes };
  return observed;
}

export async function publishedTextSnapshot(publisher, scope, state, published) {
  const observed = await publicationSnapshot(state.handle, published.linkIdentity, {
    maxBytes: state.document.textSave.bytes,
  });
  const current = await resolveFile(scope, state.selectedPath, { followLeaf: true });
  if (
    observed.hash !== state.document.textSave.hash ||
    current.absolute !== state.target ||
    current.linkIdentity !== state.document.linkIdentity ||
    entryRevision(current.stat, current.linkIdentity) !== observed.metadataRevision ||
    !(await parentMatches(publisher.native, state.target, state.document.targetParent))
  )
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  return observed;
}

// The live text owner proves partial bytes before calling the existing discard path.
export async function checkpointTextCleanup(publisher, state, bytes) {
  if (!state || state.busy || state.finished || !state.document.textSave)
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  await state.handle.sealWrites();
  let position = 0;
  const observation = await publicationSnapshot(state.handle, null, {
    maxBytes: bytes.length,
    onChunk(chunk) {
      if (!Buffer.from(chunk).equals(bytes.subarray(position, position + chunk.length)))
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      position += chunk.length;
    },
  });
  const stat = await inspect(publisher.native, state.parentHandle.handle, state.name);
  if (
    inodeIdentity(stat) !== state.document.stagedIdentity ||
    entryRevision(stat) !== observation.metadataRevision
  )
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  await publisher.barrier.run(() => {
    const record = publisher.store.getPublication(state.id);
    state.document.textPartialRevision = observation.metadataRevision;
    publisher.store.putPublication({ ...record, document: state.document });
  });
}
