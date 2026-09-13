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
import { copyMetadata } from "./file-metadata.js";
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
    // Hiding async context would not release a physical caller-held lease.
    // Reject before preparation so an awaited call cannot queue behind itself.
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
    Object.assign(state.document, patch);
    return this.barrier.run(() =>
      this.store.putPublication({
        id: state.id,
        jobId: state.jobId,
        phase,
        document: state.document,
      }),
    );
  }
  stage(scope, target, { jobId, type = "file", followLeaf = false } = {}) {
    return this.#track(async () => {
      if (
        !["file", "directory", "symlink"].includes(type) ||
        typeof followLeaf !== "boolean"
      )
        throw fileProblem("FILE_INVALID_PATH", 400);
      this.store.getJob(scope, jobId);
      const selected = await resolveFile(scope, target, {
        followLeaf,
        allowMissingLeaf: true,
      });
      assertFileMutationTarget(scope, selected);
      if (this.store.storageRoot && isWithin(selected.absolute, this.store.storageRoot))
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
      };
      try {
        state.targetParentHandle = await openParent(this.native, state.target);
        // Journal intent before the first namespace mutation; missing identities
        // after an interruption never authorize cleanup of a similarly named path.
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
        const stage = Object.freeze({
          ...Object.fromEntries(
            [
              "id",
              "file",
              "name",
              "type",
              "handle",
              "parentHandle",
              "targetParentHandle",
              "targetName",
              "target",
              "selectedPath",
              "followLeaf",
              "jobId",
            ].map((key) => [key, state[key]]),
          ),
          createLink: (text) =>
            this.#track(async () => {
              if (type !== "symlink" || state.busy || state.finished || state.linkStarted)
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
    });
  }
  async assertExpected(
    scope,
    selectedPath,
    revision,
    { followLeaf = false, expectedTarget } = {},
  ) {
    if (this.barrier.hasLease() || this.locks.hasLease())
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
    if (revision.startsWith("e1:"))
      actual = entryRevision(fresh.stat, fresh.linkIdentity);
    else {
      const parent = await openParent(this.native, fresh.absolute);
      let handle;
      try {
        handle = ownedHandle(
          this.native,
          await this.native.run("openFile", {
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
  publish(scope, stage, { expectedRevision, metadataSource = null } = {}) {
    return this.#track(async () => {
      const state = this.#stages.get(stage);
      if (!state || state.scopeId !== scope.id || state.busy || state.finished)
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      state.busy = true;
      try {
        if (metadataSource) {
          const targetHandle =
            state.handle ||
            ownedHandle(
              this.native,
              await this.native.run("openLink", {
                directory: state.parentHandle.handle,
                path: state.name,
              }),
            );
          try {
            await copyMetadata(metadataSource, targetHandle, {
              strictOwnership: true,
              preserveTimes: true,
            });
          } finally {
            if (!state.handle) await targetHandle.close();
          }
        }
        if (state.handle) await state.handle.sync();
        await state.parentHandle.sync();
        const expected = await this.assertExpected(
          scope,
          state.selectedPath,
          expectedRevision,
          {
            followLeaf: state.followLeaf,
            expectedTarget: state.target,
          },
        );
        if (state.followLeaf && expected.linkIdentity !== state.document.linkIdentity)
          throw conflict();
        const staged = await inspect(this.native, state.parentHandle.handle, state.name);
        if (!sameInode(staged, state.document.stagedIdentity) || !staged)
          throw conflict();
        const stagedContentRevision =
          state.type === "file"
            ? (await publicationSnapshot(state.handle)).publicationContentRevision
            : null;
        await this.#record(state, "prepared", {
          stagedContentRevision,
          expectedContentRevision: expected.publicationContentRevision || null,
          expectedIdentity: inodeIdentity(expected.stat),
          expectedContent: expected.stat ? contentIdentity(expected.stat) : null,
          expectedRevision,
          linkIdentity: expected.linkIdentity,
        });
        await this.locks.withPaths([state.target], async () => {
          // Expensive hashing/copying is already complete. This lease covers only
          // fresh namespace checks, the syscall, durability and durable state.
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
          await this.barrier.run(async () => {
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
          });
        });
        const targetStat = await inspect(
          this.native,
          state.targetParentHandle.handle,
          state.targetName,
        );
        const displaced = await inspect(
          this.native,
          state.parentHandle.handle,
          state.name,
        );
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
              (await publicationSnapshot(old)).publicationContentRevision !==
              state.document.expectedContentRevision
            )
              throw conflict();
          } finally {
            await old.close();
          }
        }
        if (
          stagedContentRevision &&
          (await publicationSnapshot(state.handle)).publicationContentRevision !==
            stagedContentRevision
        )
          throw conflict();
        const published = await resolveFile(scope, state.selectedPath, {
          followLeaf: state.followLeaf,
        });
        if (
          published.absolute !== state.target ||
          (state.followLeaf && published.linkIdentity !== state.document.linkIdentity) ||
          !sameInode(published.stat, state.document.stagedIdentity) ||
          !(await parentMatches(
            this.native,
            state.target,
            state.document.targetParent,
          )) ||
          !(await parentMatches(this.native, state.file, state.document.stageParent))
        )
          throw conflict();
        const revision =
          state.type === "file"
            ? await fileRevision(state.handle, published.linkIdentity)
            : entryRevision(published.stat, published.linkIdentity);
        await this.barrier.run(async () => {
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
    });
  }
  discard(stage) {
    return this.#track(async () => {
      const state = this.#stages.get(stage);
      if (!state || state.busy || state.finished)
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      state.busy = true;
      try {
        // Only a live, registered, never-published stage is eligible. Recovery
        // never derives deletion authority from an internal-looking name.
        const record = this.store.getPublication(state.id);
        if (
          record?.phase !== "staging" ||
          !(await parentMatches(this.native, state.file, state.document.stageParent))
        )
          throw conflict();
        await this.barrier.run(async () => {
          if (state.document.stagedIdentity)
            await this.native.run("removeEntry", {
              directory: state.parentHandle.handle,
              name: state.name,
              identity: state.document.stagedIdentity,
              type: state.type,
            });
          await state.parentHandle.sync();
          await removeStageDirectory(this.native, state);
          await this.#record(state, "resolved");
        });
      } finally {
        state.finished = true;
        this.#active.delete(state);
        await closeStage(state);
      }
    });
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
