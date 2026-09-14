import {
  textStageSnapshot,
  checkpointTextCleanup,
  publishedTextSnapshot,
} from "./file-text-publication.js";
import {
  checkpointArchive,
  finishArchiveArtifact,
  archiveSnapshot,
} from "./file-archive-publication.js";
import { prepareRename, restoreRenameSource } from "./file-rename.js";
import { transferRevisions } from "./file-transfer-completion.js";
import { discardPublication } from "./file-publish-discard.js";
import { bindExtract } from "./file-extract-store.js";
import { reopenExtractStage } from "./file-extract-stage.js";
import { checkpointUpload, uploadSnapshot } from "./file-upload-publication.js";
import {
  assertPublicationExpected,
  recordPublication,
  preservePublicationMetadata,
} from "./file-publish-validation.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { FileNative } from "./file-native.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import {
  resolveFile,
  assertFileMutationTarget,
  entryRevision,
  isWithin,
} from "./file-paths.js";
import { adoptStageEntry } from "./file-stage-adoption.js";
import {
  inodeIdentity,
  contentIdentity,
  sameInode,
  inspect,
  ownedHandle,
  fileRevision,
  publicationSnapshot,
  openParent,
  parentMatches,
  closeStage,
  removeStageDirectory,
} from "./file-stage.js";

export { fileRevision } from "./file-stage.js";
const conflict = () => fileProblem("FILE_CONFLICT_CHANGED", 409);
export class FilePublisher {
  #stages = new WeakMap();
  #active = new Set();
  #pending = new Set();
  #native;
  #ownNative;
  #closed = false;
  #closing;
  constructor({ store, native, locks, barrier }) {
    Object.assign(this, { store, locks, barrier });
    this.#native = native;
    this.#ownNative = !native;
  }
  get native() {
    return (this.#native ||= new FileNative());
  }
  #track(action) {
    if (this.#closed) return Promise.reject(fileProblem("FILE_JOBS_CLOSED", 503));
    // Reject physical caller leases before preparation to prevent self-deadlock.
    if (this.barrier.hasLease() || this.locks.hasLease())
      return Promise.reject(fileProblem("FILE_INVALID_OPERATION", 400));
    const result = action();
    this.#pending.add(result);
    result.then(
      () => this.#pending.delete(result),
      () => this.#pending.delete(result),
    );
    return result;
  }
  #record(state, phase, patch = {}) {
    return recordPublication(this, state, phase, patch);
  }
  stage(scope, target, options) {
    return this.#track(() => this.#stage(scope, target, options));
  }
  async #stage(
    scope,
    target,
    {
      jobId,
      type = "file",
      followLeaf = false,
      transferId,
      upload = false,
      archive = false,
      extract = null,
      targetGuard,
      textSave = false,
    } = {},
  ) {
    if (
      !["file", "directory", "symlink"].includes(type) ||
      typeof followLeaf !== "boolean"
    )
      throw fileProblem("FILE_INVALID_PATH", 400);
    this.store.getJob(scope, jobId);
    const binding = archive ? this.store.archives.bind(scope, jobId, target) : null;
    const privateArtifact = binding?.mode === "download";
    if (privateArtifact && target !== this.store.archives.target(scope, jobId))
      throw conflict();
    const selected = privateArtifact
      ? { absolute: target, path: target, linkIdentity: null }
      : await resolveFile(scope, target, { followLeaf, allowMissingLeaf: true });
    if (!privateArtifact) assertFileMutationTarget(scope, selected);
    this.store.bindTransfer(scope, jobId, transferId, selected.path);
    if (
      !privateArtifact &&
      this.store.storageRoot &&
      isWithin(selected.absolute, this.store.storageRoot)
    )
      throw fileProblem("FILE_PROTECTED_PATH", 403);
    const state = {
      id: randomUUID(),
      jobId,
      type,
      followLeaf,
      scopeId: scope.id,
      target: selected.absolute,
      selectedPath: selected.path,
      targetName: path.basename(selected.absolute),
      name: "content",
    };
    state.directoryName = `.agentpier-stage-${state.id}`;
    state.file = path.join(path.dirname(state.target), state.directoryName, state.name);
    state.document = {
      version: 1,
      target: state.target,
      staged: state.file,
      type,
      selectedPath: state.selectedPath,
      followLeaf,
      scopeId: scope.id,
      scope: { ...scope },
      linkIdentity: selected.linkIdentity,
      transferId,
      ...(textSave
        ? { textSave: this.store.text.bind(scope, jobId, selected.path) }
        : {}),
      ...(binding ? { archive: binding } : {}),
      ...(extract
        ? { extract: bindExtract(this.store, scope, jobId, selected.path, extract) }
        : {}),
      ...(upload ? { upload: this.store.uploads.bind(scope, jobId, selected.path) } : {}),
    };
    try {
      state.targetParentHandle = await openParent(this.native, state.target);
      await targetGuard?.(selected, state.targetParentHandle);
      // Journal intent first; missing identities never authorize guessed cleanup.
      await this.#record(state, "creating", {
        targetParent: inodeIdentity(await state.targetParentHandle.stat()),
      });
      state.parentHandle = ownedHandle(
        this.native,
        await this.native.run("createDirectory", {
          directory: state.targetParentHandle.handle,
          name: state.directoryName,
        }),
      );
      await this.#record(state, "creating", {
        stageParent: inodeIdentity(await state.parentHandle.stat()),
      });
      if (type !== "symlink")
        state.handle = ownedHandle(
          this.native,
          await this.native.run(type === "file" ? "createFile" : "createDirectory", {
            directory: state.parentHandle.handle,
            name: state.name,
          }),
        );
      else state.handle = null;
      await this.#record(state, "staging", {
        stagedIdentity: state.handle ? inodeIdentity(await state.handle.stat()) : null,
      });
      await state.parentHandle.sync();
      await state.targetParentHandle.sync();
      if (upload) await checkpointUpload(this, state);
      if (archive) await checkpointArchive(this, state);
      const stage = Object.freeze({
        ...Object.fromEntries(
          [
            "id",
            "file",
            "name",
            "type",
            "parentHandle",
            "targetParentHandle",
            "targetName",
            "target",
            "selectedPath",
            "followLeaf",
            "jobId",
          ].map((key) => [key, state[key]]),
        ),
        get handle() {
          return state.handle;
        },
        adoptEntry: (source) => this.#adopt(state, source),
        createLink: (text) =>
          this.#track(async () => {
            if (
              type !== "symlink" ||
              state.busy ||
              state.finished ||
              state.linkStarted ||
              state.adoptionStarted
            )
              throw fileProblem("FILE_INVALID_OPERATION", 400);
            state.linkStarted = true;
            const stat = await this.native.run("createLink", {
              directory: state.parentHandle.handle,
              name: state.name,
              text,
            });
            await this.#record(state, "staging", {
              stagedIdentity: inodeIdentity(stat),
            });
            await state.parentHandle.sync();
          }),
      });
      this.#stages.set(stage, state);
      this.#active.add(state);
      return stage;
    } catch (error) {
      await closeStage(state);
      throw fileSystemProblem(error);
    }
  }
  #adopt(state, source) {
    return this.#track(() =>
      adoptStageEntry({
        state,
        source,
        native: this.native,
        barrier: this.barrier,
        record: (phase, patch) => this.#record(state, phase, patch),
      }),
    );
  }
  assertExpected(scope, selectedPath, revision, options) {
    return assertPublicationExpected(this, scope, selectedPath, revision, options);
  }
  publish(scope, stage, options) {
    return this.#track(() => this.#publish(scope, stage, options));
  }
  async #publish(
    scope,
    stage,
    { expectedRevision, metadataSource = null, refreshScope, beforeMutation } = {},
  ) {
    const state = this.#stages.get(stage);
    if (!state || state.scopeId !== scope.id || state.busy || state.finished)
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    state.busy = true;
    try {
      if (metadataSource)
        await preservePublicationMetadata(this.native, state, metadataSource);
      if (state.handle) await state.handle.sync();
      await state.parentHandle.sync();
      const expected = await this.assertExpected(
        scope,
        state.selectedPath,
        expectedRevision,
        {
          followLeaf: state.followLeaf,
          expectedTarget: state.target,
          maxBytes: state.document.textSave ? this.store.limits.textBytes : undefined,
        },
      );
      if (state.followLeaf && expected.linkIdentity !== state.document.linkIdentity)
        throw conflict();
      const staged = await inspect(this.native, state.parentHandle.handle, state.name);
      if (!sameInode(staged, state.document.stagedIdentity) || !staged) throw conflict();
      const stagedContentRevision =
        state.type === "file"
          ? (
              await (state.document.textSave
                ? textStageSnapshot(state)
                : (state.document.archive ? archiveSnapshot : uploadSnapshot)(
                    this,
                    state,
                  ))
            ).publicationContentRevision
          : null;
      await this.#record(state, "prepared", {
        stagedContentRevision,
        expectedContentRevision: expected.publicationContentRevision || null,
        expectedIdentity: inodeIdentity(expected.stat),
        expectedContent: expected.stat ? contentIdentity(expected.stat) : null,
        expectedRevision,
        linkIdentity: expected.linkIdentity,
      });
      await refreshScope?.();
      await this.locks.withPaths(
        [
          state.target,
          ...(state.document.renameSource ? [state.document.renameSource.absolute] : []),
        ],
        () =>
          this.barrier.run(async () => {
            await beforeMutation?.();
            // Hashing is complete; only namespace checks and durable mutation remain.
            const fresh = await resolveFile(scope, state.selectedPath, {
              followLeaf: state.followLeaf,
              allowMissingLeaf: true,
            });
            if (
              fresh.absolute !== state.target ||
              fresh.linkIdentity !== expected.linkIdentity ||
              (fresh.stat ? entryRevision(fresh.stat) : null) !==
                (expected.stat ? entryRevision(expected.stat) : null) ||
              !(await parentMatches(
                this.native,
                state.target,
                state.document.targetParent,
              )) ||
              !(await parentMatches(this.native, state.file, state.document.stageParent))
            )
              throw conflict();
            const targetStat = await inspect(
              this.native,
              state.targetParentHandle.handle,
              state.targetName,
            );
            if (
              (targetStat ? entryRevision(targetStat) : null) !==
                (expected.stat ? entryRevision(expected.stat) : null) ||
              !sameInode(
                await inspect(this.native, state.parentHandle.handle, state.name),
                state.document.stagedIdentity,
              )
            )
              throw conflict();
            await refreshScope?.();
            await beforeMutation?.();
            await this.native.run(expected.stat ? "exchange" : "renameNoReplace", {
              oldParent: state.parentHandle.handle,
              oldName: state.name,
              newParent: state.targetParentHandle.handle,
              newName: state.targetName,
            });
            const displaced = await inspect(
              this.native,
              state.parentHandle.handle,
              state.name,
            );
            await this.#record(state, "exchanged", {
              displacedIdentity: inodeIdentity(displaced),
            });
            await state.parentHandle.sync();
            await state.targetParentHandle.sync();
          }),
      );
      const targetStat = await inspect(
        this.native,
        state.targetParentHandle.handle,
        state.targetName,
      );
      const displaced = await inspect(this.native, state.parentHandle.handle, state.name);
      if (
        !sameInode(targetStat, state.document.stagedIdentity) ||
        inodeIdentity(displaced) !== state.document.expectedIdentity ||
        (displaced && contentIdentity(displaced) !== state.document.expectedContent)
      )
        throw conflict();
      if (state.followLeaf) {
        const fresh = await resolveFile(scope, state.selectedPath, {
          followLeaf: true,
        });
        if (
          fresh.absolute !== state.target ||
          fresh.linkIdentity !== state.document.linkIdentity
        )
          throw conflict();
      }
      if (displaced && expectedRevision.startsWith("d1:")) {
        const old = ownedHandle(
          this.native,
          await this.native.run("openFile", {
            directory: state.parentHandle.handle,
            path: state.name,
          }),
        );
        try {
          if (
            (
              await publicationSnapshot(old, null, {
                maxBytes: state.document.textSave
                  ? this.store.limits.textBytes
                  : undefined,
              })
            ).publicationContentRevision !== state.document.expectedContentRevision
          )
            throw conflict();
        } finally {
          await old.close();
        }
      }
      if (
        stagedContentRevision &&
        (
          await publicationSnapshot(state.handle, null, {
            maxBytes: state.document.textSave?.bytes,
          })
        ).publicationContentRevision !== stagedContentRevision
      )
        throw conflict();
      const published = await resolveFile(scope, state.selectedPath, {
        followLeaf: state.followLeaf,
      });
      if (
        published.absolute !== state.target ||
        (state.followLeaf && published.linkIdentity !== state.document.linkIdentity) ||
        !sameInode(published.stat, state.document.stagedIdentity) ||
        !(await parentMatches(this.native, state.target, state.document.targetParent)) ||
        !(await parentMatches(this.native, state.file, state.document.stageParent))
      )
        throw conflict();
      const observation = state.document.textSave
        ? await publishedTextSnapshot(this, scope, state, published)
        : null;
      const revision =
        observation?.revision ||
        (state.type === "file"
          ? await fileRevision(state.handle, published.linkIdentity)
          : entryRevision(published.stat, published.linkIdentity));
      const completion = {
        id: state.id,
        jobId: state.jobId,
        phase: "exchanged",
        document: state.document,
      };
      const revisions = await transferRevisions(this.store, completion, this.native);
      await this.barrier.run(async () => {
        this.store.completeTransfer(completion, revision, revisions, observation);
        if (!displaced) await removeStageDirectory(this.native, state);
        await this.#record(state, displaced ? "swapped" : "resolved");
      });
      return {
        path: state.selectedPath,
        revision,
        recoveryId: displaced ? state.id : null,
      };
    } catch (cause) {
      const error =
        cause.code === "FILE_NATIVE_UNSUPPORTED"
          ? fileProblem("FILE_WRITE_UNSUPPORTED", 503)
          : fileSystemProblem(cause);
      await this.#record(state, "interrupted", {
        issue: { code: error.code, args: {} },
      });
      throw error;
    } finally {
      state.finished = true;
      this.#active.delete(state);
      await closeStage(state);
    }
  }
  rename(scope, sourcePath, targetPath, options = {}) {
    return this.#track(async () => {
      let prepared;
      const record = (state, phase, patch) => this.#record(state, phase, patch);
      try {
        prepared = await prepareRename({
          publisher: this,
          scope,
          sourcePath,
          targetPath,
          options,
          stage: (...args) => this.#stage(...args),
          stateFor: (stage) => this.#stages.get(stage),
          record,
        });
        const { stage, state, expectedRevision } = prepared;
        return await this.#publish(scope, stage, {
          expectedRevision,
          refreshScope: options.refreshScope,
          beforeMutation: async () => {
            options.signal?.throwIfAborted();
            const source = await resolveFile(scope, sourcePath, {
              followLeaf: false,
              allowMissingLeaf: true,
            });
            if (
              source.absolute !== state.document.renameSource.absolute ||
              source.stat ||
              !(await parentMatches(
                this.native,
                source.absolute,
                state.document.renameSource.parentIdentity,
              ))
            )
              throw conflict();
          },
        });
      } catch (error) {
        const stage = prepared?.stage || error.renameStage;
        delete error.renameStage;
        const state = stage && this.#stages.get(stage);
        if (state) {
          await restoreRenameSource({
            publisher: this,
            state,
            record,
            refreshScope: options.refreshScope,
          });
          state.finished = true;
          this.#active.delete(state);
          await closeStage(state);
          error.recoveryId = state.id;
        }
        const failure = fileSystemProblem(error);
        if (state) failure.recoveryId = state.id;
        if (
          state?.crossDeviceAttempt &&
          this.store.getPublication(state.id)?.phase === "resolved"
        ) {
          await this.assertExpected(scope, sourcePath, options.sourceRevision);
          failure.crossDeviceSafe = true;
        }
        throw failure;
      }
    });
  }
  checkpointTextCleanup(stage, bytes) {
    return this.#track(() => checkpointTextCleanup(this, this.#stages.get(stage), bytes));
  }
  discard(stage) {
    return this.#track(() =>
      discardPublication(this, this.#stages.get(stage), this.#active, (...args) =>
        this.#record(...args),
      ),
    );
  }
  release(stage) {
    return this.#track(async () => {
      const state = this.#stages.get(stage);
      if (!state || state.busy || state.finished)
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      state.finished = true;
      this.#active.delete(state);
      await closeStage(state);
    });
  }
  checkpointArchive(stage, proof, options) {
    return this.#track(() =>
      checkpointArchive(this, this.#stages.get(stage), proof, options),
    );
  }
  resumeExtract(scope, id) {
    return this.#track(async () => {
      const state = await reopenExtractStage(this, scope, id);
      const stage = Object.freeze({ id: state.id, handle: state.handle });
      this.#stages.set(stage, state);
      this.#active.add(state);
      return stage;
    });
  }
  finishArchive(stage, options) {
    return this.#track(() =>
      finishArchiveArtifact(this, this.#stages.get(stage), options),
    );
  }
  checkpointUpload(stage, hash) {
    return this.#track(() => checkpointUpload(this, this.#stages.get(stage), hash));
  }
  close() {
    this.#closed = true;
    return (this.#closing ||= (async () => {
      await Promise.allSettled([...this.#pending]);
      const outcomes = await Promise.allSettled(
        [...this.#active].map((state) => {
          state.finished = true;
          return closeStage(state);
        }),
      );
      this.#active.clear();
      if (this.#ownNative && this.#native) await this.#native.close();
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed) throw failed.reason;
    })());
  }
}
