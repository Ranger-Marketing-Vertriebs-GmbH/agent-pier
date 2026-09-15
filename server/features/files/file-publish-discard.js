import { entryRevision } from "./file-paths.js";
import { inspect } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";
import { discardExtractStage } from "./file-extract-stage.js";
import { discardArchivePayload } from "./file-archive-publication.js";
import { discardUploadPayload } from "./file-upload-publication.js";
import { discardCopyStage } from "./file-copy-cleanup.js";
import { parentMatches, closeStage, removeStageDirectory } from "./file-stage.js";
const conflict = () => fileProblem("FILE_CONFLICT_CHANGED", 409);

export async function discardPublication(publisher, state, active, record) {
  if (state?.document.extract) {
    if (state.busy && !state.finished) throw conflict();
    try {
      return await discardExtractStage(
        publisher,
        publisher.store.getPublication(state.id),
      );
    } finally {
      state.finished = true;
      active.delete(state);
      await closeStage(state);
    }
  }
  if (state?.document.upload || state?.document.archive) {
    if (state.busy && !state.finished) throw conflict();
    try {
      return await (
        state.document.archive ? discardArchivePayload : discardUploadPayload
      )(publisher, publisher.store.getPublication(state.id));
    } finally {
      state.finished = true;
      active.delete(state);
      await closeStage(state);
    }
  }
  if (state?.finished && state.document.transferId)
    return discardCopyStage(publisher, state, record);
  if (!state || state.busy || state.finished)
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  state.busy = true;
  try {
    // Only a live registered stage is eligible; names never grant authority.
    const publication = publisher.store.getPublication(state.id);
    if (
      publication?.phase !== "staging" ||
      !(await parentMatches(publisher.native, state.file, state.document.stageParent))
    )
      throw conflict();
    await publisher.barrier.run(async () => {
      if (state.document.textSave) {
        const current = await inspect(
          publisher.native,
          state.parentHandle.handle,
          state.name,
        );
        if (
          !current ||
          !state.document.textPartialRevision ||
          entryRevision(current) !== state.document.textPartialRevision
        )
          throw conflict();
      }
      if (state.document.stagedIdentity)
        await publisher.native.run("removeEntry", {
          directory: state.parentHandle.handle,
          name: state.name,
          identity: state.document.stagedIdentity,
          type: state.type,
        });
      await state.parentHandle.sync();
      await removeStageDirectory(publisher.native, state);
      await record(state, "resolved");
    });
  } finally {
    state.finished = true;
    active.delete(state);
    await closeStage(state);
  }
}
