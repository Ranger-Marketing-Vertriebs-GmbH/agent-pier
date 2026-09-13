import { assertAdoptionSource } from "./file-trash-storage.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import { inspect, inodeIdentity, ownedHandle } from "./file-stage.js";
import { treeConflict } from "./file-tree.js";

export async function adoptStageEntry({ state, source, native, barrier, record }) {
  if (
    state.busy ||
    state.finished ||
    state.linkStarted ||
    state.adoptionStarted ||
    state.type !== source?.type
  )
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  state.busy = true;
  try {
    await assertAdoptionSource(source, native);
    const original = await inspect(native, source.parentHandle.handle, source.name);
    if (
      !original ||
      inodeIdentity(original) !== source.identity ||
      original.type !== state.type
    )
      throw treeConflict();
    if (original.dev !== (await state.parentHandle.stat()).dev)
      throw fileProblem("FILE_CROSS_DEVICE", 409);
    await state.handle?.sealWrites();
    const initial = await inspect(native, state.parentHandle.handle, state.name);
    if (inodeIdentity(initial) !== state.document.stagedIdentity) throw treeConflict();
    if (initial?.type === "file" && initial.size !== 0n) throw treeConflict();
    if (initial?.type === "directory") {
      const stream = ownedHandle(
        native,
        await native.run("openDirectory", {
          directory: state.parentHandle.handle,
          path: state.name,
        }),
      );
      try {
        if (await native.run("readDirectory", { handle: stream.handle }))
          throw treeConflict();
      } finally {
        await stream.close();
      }
    }
    state.adoptionStarted = true;
    try {
      await record("adopting", {
        adoptionSource: {
          parentIdentity: inodeIdentity(await source.parentHandle.stat()),
          name: source.name,
          identity: source.identity,
          type: source.type,
        },
        initialIdentity: state.document.stagedIdentity,
      });
      await barrier.run(async () => {
        await assertAdoptionSource(source, native);
        if (
          inodeIdentity(
            await inspect(native, source.parentHandle.handle, source.name),
          ) !== source.identity
        )
          throw treeConflict();
        if (initial)
          await native.run("removeEntry", {
            directory: state.parentHandle.handle,
            name: state.name,
            identity: state.document.stagedIdentity,
            type: state.type,
          });
        await state.handle?.close();
        state.handle = null;
        await native.run("renameNoReplace", {
          oldParent: source.parentHandle.handle,
          oldName: source.name,
          newParent: state.parentHandle.handle,
          newName: state.name,
        });
        state.document.stagedIdentity = source.identity;
        if (state.type !== "symlink")
          state.handle = ownedHandle(
            native,
            await native.run(state.type === "directory" ? "openLookup" : "openFile", {
              directory: state.parentHandle.handle,
              path: state.name,
            }),
          );
        await state.parentHandle.sync();
        await source.parentHandle.sync();
        await record("staging");
      });
    } catch (error) {
      await record("interrupted", {
        issue: { code: fileSystemProblem(error).code, args: {} },
      });
      throw error;
    }
  } finally {
    state.busy = false;
  }
}
