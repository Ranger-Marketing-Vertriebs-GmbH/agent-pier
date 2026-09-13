import path from "node:path";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import {
  resolveFile,
  entryRevision,
  assertFileMutationTarget,
  isWithin,
} from "./file-paths.js";
import {
  openParent,
  parentMatches,
  inspect,
  inodeIdentity,
  contentIdentity,
  ownedHandle,
} from "./file-stage.js";
const changed = () => fileProblem("FILE_CONFLICT_CHANGED", 409);

async function exactNames(native, parent, selectedNames, signal) {
  const stream = ownedHandle(
    native,
    await native.run("openDirectory", { directory: parent.handle, path: "" }),
  );
  const names = new Set();
  let inspected = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const entry = await native.run("readDirectory", { handle: stream.handle });
      if (!entry) return names;
      if (++inspected > 100000) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      if (selectedNames.includes(entry.name)) names.add(entry.name);
    }
  } finally {
    await stream.close();
  }
}

export async function prepareRename({
  publisher,
  scope,
  sourcePath,
  targetPath,
  options,
  stage: makeStage,
  stateFor,
  record,
}) {
  const { sourceRevision, expectedRevision, jobId, signal, refreshScope } = options;
  publisher.store.getJob(scope, jobId);
  const source = await publisher.assertExpected(scope, sourcePath, sourceRevision);
  const target = await publisher.assertExpected(scope, targetPath, expectedRevision);
  if (source.parent !== target.parent || source.path === target.path)
    throw fileProblem("FILE_SAME_PATH", 409);
  const type = source.stat.isFile()
    ? "file"
    : source.stat.isDirectory()
      ? "directory"
      : source.stat.isSymbolicLink()
        ? "symlink"
        : null;
  if (!type) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
  for (const privatePath of [
    publisher.store.storageRoot,
    ...publisher.store
      .listPublications()
      .filter((record) => record.phase !== "resolved" && record.document.staged)
      .map((record) => path.dirname(record.document.staged)),
  ]) {
    if (
      [source.absolute, target.absolute].some(
        (absolute) => isWithin(privatePath, absolute) || isWithin(absolute, privatePath),
      )
    )
      throw fileProblem("FILE_PROTECTED_PATH", 403);
  }
  const native = publisher.native;
  const sourceParent = await openParent(native, source.absolute);
  let stage, state;
  try {
    const parentIdentity = inodeIdentity(await sourceParent.stat());
    let caseOnly = false;
    if (target.stat && inodeIdentity(source.stat) === inodeIdentity(target.stat)) {
      const names = await exactNames(
        native,
        sourceParent,
        [path.basename(source.absolute), path.basename(target.absolute)],
        signal,
      );
      if (
        !names.has(path.basename(source.absolute)) ||
        names.has(path.basename(target.absolute))
      )
        throw fileProblem("FILE_SAME_PATH", 409);
      caseOnly = true;
    } else if (
      target.stat &&
      (type === "directory" ||
        !(type === "file" ? target.stat.isFile() : target.stat.isSymbolicLink()))
    ) {
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    }
    stage = await makeStage(scope, targetPath, { jobId, type, followLeaf: false });
    state = stateFor(stage);
    await state.handle?.sealWrites();
    const provenance = {
      path: source.path,
      absolute: source.absolute,
      parentIdentity,
      identity: inodeIdentity(source.stat),
      type,
      revision: sourceRevision,
      content: contentIdentity(source.stat),
      caseOnly,
      disposition: "prepared",
    };
    await record(state, "rename_prepared", {
      renameSource: provenance,
      initialIdentity: state.document.stagedIdentity,
    });
    await refreshScope?.();
    signal?.throwIfAborted();
    await publisher.locks.withPaths([source.absolute, target.absolute], () =>
      publisher.barrier.run(async () => {
        const current = await resolveFile(scope, sourcePath, { followLeaf: false });
        const destination = await resolveFile(scope, targetPath, {
          followLeaf: false,
          allowMissingLeaf: true,
        });
        assertFileMutationTarget(scope, current);
        assertFileMutationTarget(scope, destination);
        if (
          current.absolute !== source.absolute ||
          destination.absolute !== target.absolute ||
          entryRevision(current.stat, current.linkIdentity) !== sourceRevision ||
          (destination.stat
            ? entryRevision(destination.stat, destination.linkIdentity)
            : null) !== expectedRevision ||
          !(await parentMatches(native, source.absolute, parentIdentity)) ||
          !(await parentMatches(native, state.file, state.document.stageParent)) ||
          !(await parentMatches(native, state.target, state.document.targetParent))
        )
          throw changed();
        await publisher.barrier.run(async () => {
          await refreshScope?.();
          signal?.throwIfAborted();
          const currentSource = await inspect(
            native,
            sourceParent.handle,
            path.basename(source.absolute),
          );
          const currentTarget = await inspect(
            native,
            state.targetParentHandle.handle,
            state.targetName,
          );
          if (
            !currentSource ||
            entryRevision(currentSource) !== entryRevision(current.stat) ||
            (currentTarget ? entryRevision(currentTarget) : null) !==
              (destination.stat ? entryRevision(destination.stat) : null)
          )
            throw changed();
          if (state.document.stagedIdentity)
            await native.run("removeEntry", {
              directory: state.parentHandle.handle,
              name: state.name,
              identity: state.document.stagedIdentity,
              type,
            });
          await state.handle?.close();
          state.handle = null;
          await native.run("renameNoReplace", {
            oldParent: sourceParent.handle,
            oldName: path.basename(source.absolute),
            newParent: state.parentHandle.handle,
            newName: state.name,
          });
          state.document.stagedIdentity = provenance.identity;
          provenance.disposition = "staged";
          await record(state, "rename_staged");
          const adopted = await inspect(native, state.parentHandle.handle, state.name);
          if (contentIdentity(adopted) !== provenance.content) throw changed();
          if (type !== "symlink")
            state.handle = ownedHandle(
              native,
              await native.run(type === "directory" ? "openLookup" : "openFile", {
                directory: state.parentHandle.handle,
                path: state.name,
              }),
            );
          await sourceParent.sync();
          await state.parentHandle.sync();
        });
      }),
    );
    return { stage, state, expectedRevision: caseOnly ? null : expectedRevision };
  } catch (error) {
    if (state) error.renameStage = stage;
    throw error;
  } finally {
    await sourceParent.close();
  }
}

/** Never overwrites a new original-path entry. Uncertain bytes stay journalled. */
export async function restoreRenameSource({ publisher, state, record, refreshScope }) {
  const provenance = state.document.renameSource;
  if (!provenance) return;
  const native = publisher.native;
  let sourceParent, stageParent;
  try {
    await refreshScope?.();
    sourceParent = await openParent(native, provenance.absolute);
    stageParent = await openParent(native, state.file).catch(async (error) => {
      if (
        error.code !== "FILE_NOT_FOUND" ||
        !(await parentMatches(native, provenance.absolute, provenance.parentIdentity)) ||
        inodeIdentity(
          await inspect(native, sourceParent.handle, path.basename(provenance.absolute)),
        ) !== provenance.identity ||
        (await inspect(native, sourceParent.handle, state.directoryName))
      )
        throw error;
      provenance.disposition = "restored";
      await record(state, "resolved");
      return null;
    });
    if (!stageParent) return;
    await publisher.locks.withPaths([provenance.absolute, state.target], () =>
      publisher.barrier.run(async () => {
        if (
          inodeIdentity(await sourceParent.stat()) !== provenance.parentIdentity ||
          inodeIdentity(await stageParent.stat()) !== state.document.stageParent ||
          !(await parentMatches(
            native,
            provenance.absolute,
            provenance.parentIdentity,
          )) ||
          !(await parentMatches(native, state.file, state.document.stageParent))
        )
          throw changed();
        const selected = await resolveFile(state.document.scope, provenance.path, {
          followLeaf: false,
          allowMissingLeaf: true,
        });
        assertFileMutationTarget(state.document.scope, selected);
        if (selected.absolute !== provenance.absolute) throw changed();
        const staged = await inspect(native, stageParent.handle, state.name);
        const original = await inspect(
          native,
          sourceParent.handle,
          path.basename(provenance.absolute),
        );
        if (inodeIdentity(staged) === provenance.identity) {
          if (original) throw changed();
          await publisher.barrier.run(async () => {
            await refreshScope?.();
            await native.run("renameNoReplace", {
              oldParent: stageParent.handle,
              oldName: state.name,
              newParent: sourceParent.handle,
              newName: path.basename(provenance.absolute),
            });
            provenance.disposition = "restored";
            await sourceParent.sync();
            await stageParent.sync();
            await record(state, "rename_restored");
          });
        } else if (
          inodeIdentity(original) === provenance.identity &&
          (!staged || inodeIdentity(staged) === state.document.initialIdentity)
        ) {
          provenance.disposition = "restored";
          await record(state, "rename_restored");
        } else return;
        await publisher.barrier.run(async () => {
          if (staged && inodeIdentity(staged) === state.document.initialIdentity)
            await native.run("removeEntry", {
              directory: stageParent.handle,
              name: state.name,
              identity: state.document.initialIdentity,
              type: state.type,
            });
          await native.run("removeEntry", {
            directory: sourceParent.handle,
            name: state.directoryName,
            identity: state.document.stageParent,
            type: "directory",
          });
          await sourceParent.sync();
          await record(state, "resolved");
        });
      }),
    );
  } catch (error) {
    await record(state, "interrupted", {
      issue: { code: fileSystemProblem(error).code, args: {} },
    });
  } finally {
    await stageParent?.close();
    await sourceParent?.close();
  }
}
