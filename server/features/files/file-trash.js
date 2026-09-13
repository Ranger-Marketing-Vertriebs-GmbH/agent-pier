import { retainRenameSource } from "./file-rename-recovery.js";
import path from "node:path";
import { completeTrashAdoption } from "./file-trash-adoption.js";
import { recoverTrash } from "./file-trash-recovery.js";
import { randomUUID } from "node:crypto";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import {
  resolveFile,
  assertFileMutationTarget,
  isWithin,
  entryRevision,
} from "./file-paths.js";
import { readFileLimits } from "./file-limits.js";
import {
  closeHandles,
  inodeIdentity,
  inspect,
  openParent,
  parentMatches,
} from "./file-stage.js";
import {
  scanTree,
  assertTree,
  removeTree,
  treeRevision,
  treeConflict,
} from "./file-tree.js";
import { copyVerified, openTreeSource, privateTreeSource } from "./file-tree-transfer.js";
import {
  privateTrashStage,
  openTrashPayload,
  trashAdoptionSource,
} from "./file-trash-storage.js";

export class FileTrash {
  constructor({
    store,
    native,
    publisher,
    limits = readFileLimits(),
    locks = publisher.locks,
    barrier = publisher.barrier,
  }) {
    Object.assign(this, {
      store,
      native: native || publisher.native,
      publisher,
      limits,
      locks,
      barrier,
    });
    this.pending = new Set();
    this.busy = new Set();
    this.closed = false;
  }
  track(action) {
    if (this.closed) return Promise.reject(fileProblem("FILE_JOBS_CLOSED", 503));
    if (this.barrier.hasLease() || this.locks.hasLease())
      return Promise.reject(fileProblem("FILE_INVALID_OPERATION", 400));
    const promise = action();
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  entry(id, action) {
    return this.track(async () => {
      if (this.busy.has(id)) throw treeConflict();
      this.busy.add(id);
      try {
        return await action();
      } finally {
        this.busy.delete(id);
      }
    });
  }
  save(record) {
    return this.barrier.run(() => this.store.putTrash(record));
  }
  authorized(scope, id) {
    const record = this.store.getTrash(id);
    if (
      !record ||
      !record.originalAbsolute ||
      (scope.kind === "project" && !isWithin(scope.root, record.originalAbsolute))
    )
      throw fileProblem("FILE_NOT_FOUND", 404);
    if (scope.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    return record;
  }
  async observe(record) {
    record = this.store.getTrash(record.id);
    if (!record) return { availability: "unavailable", revision: null };
    if (record.phase !== "recoverable")
      return { availability: "pending", revision: null };
    let source;
    try {
      source = await openTrashPayload(this.native, record);
      await source.assertAuthority();
      const rows = await assertTree(
        this.native,
        source.parent,
        source.name,
        record.payloadManifest,
        { limits: this.limits },
      );
      return { availability: "recoverable", revision: treeRevision(rows) };
    } catch (error) {
      return {
        availability: error.code === "FILE_NOT_FOUND" ? "unavailable" : "changed",
        revision: null,
      };
    } finally {
      await source?.parent.close();
    }
  }
  list(scope, cursor) {
    return this.track(() => this.listEntries(scope, cursor));
  }
  async listEntries(scope, cursor) {
    const page = this.store.listTrashRecords(scope, cursor),
      entries = [];
    for (const record of page.entries)
      entries.push({
        id: record.id,
        originalPath:
          scope.kind === "project"
            ? path.relative(scope.root, record.originalAbsolute)
            : record.originalAbsolute,
        deletedAt: record.deletedAt,
        type: record.type,
        size: record.size,
        reason: record.reason,
        ...(await this.observe(record)),
      });
    return { entries, nextCursor: page.nextCursor };
  }
  assertProtected(absolute) {
    const paths = [
      this.store.storageRoot,
      ...this.store
        .listPublications()
        .filter(
          (record) =>
            record.phase !== "resolved" && typeof record.document.staged === "string",
        )
        .map((record) => path.dirname(record.document.staged)),
    ];
    if (
      paths.some(
        (privatePath) =>
          isWithin(absolute, privatePath) || isWithin(privatePath, absolute),
      )
    )
      throw fileProblem("FILE_PROTECTED_PATH", 403);
  }
  capture(scope, source, { jobId, reason = "deleted", signal } = {}) {
    return this.track(async () => {
      this.store.getJob(scope, jobId);
      if (!["deleted", "replaced"].includes(reason))
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      const selected = await resolveFile(scope, source, { followLeaf: false });
      assertFileMutationTarget(scope, selected);
      this.assertProtected(selected.absolute);
      const record = {
        id: randomUUID(),
        jobId,
        scopeId: scope.id,
        scope: { ...scope },
        originalPath: selected.path,
        originalAbsolute: selected.absolute,
        deletedAt: new Date().toISOString(),
        reason,
        phase: "capturing",
      };
      return this.captureSource(scope, source, record, signal);
    });
  }
  async captureSource(scope, source, record, signal) {
    const selected = await openTreeSource(scope, source, this.native);
    let stage;
    try {
      const rows = await scanTree(this.native, selected.parent, selected.name, {
        limits: this.limits,
        signal,
      });
      Object.assign(record, {
        type: rows[0].type,
        size: rows.reduce((sum, row) => sum + (row.type === "file" ? row.size : 0), 0),
        sourceManifest: rows,
      });
      record.sourceParentIdentity = inodeIdentity(await selected.parent.stat());
      await this.save(record);
      stage = await privateTrashStage(this.store, this.native, record, (value) =>
        this.save(value),
      );
      const checkpoint = ({ entry }) =>
        this.barrier.run(() =>
          this.store.putTrashItem(record.id, entry.relativePath, entry),
        );
      await selected.assertAuthority();
      await assertTree(this.native, selected.parent, selected.name, rows, {
        limits: this.limits,
        signal,
      });
      let copied;
      try {
        await this.locks.withPaths([record.originalAbsolute], () =>
          this.barrier.run(async () => {
            signal?.throwIfAborted();
            await selected.assertAuthority();
            const fresh = await inspect(
              this.native,
              selected.parent.handle,
              selected.name,
            );
            if (!fresh || entryRevision(fresh) !== rows[0].revision) throw treeConflict();
            await this.native.run("renameNoReplace", {
              oldParent: selected.parent.handle,
              oldName: selected.name,
              newParent: stage.parentHandle.handle,
              newName: stage.name,
            });
            record.location.identity = rows[0].identity;
            record.phase = "moved";
            await this.save(record);
            await selected.parent.sync();
            await stage.parentHandle.sync();
          }),
        );
      } catch (error) {
        if (!["EXDEV", "FILE_CROSS_DEVICE"].includes(error.code)) throw error;
        record.phase = "copying";
        await this.save(record);
        await stage.populate();
        copied = await copyVerified(scope, source, stage, {
          limits: this.limits,
          signal,
          strictMetadata: true,
          report: checkpoint,
          mutate: (fn) =>
            this.locks.withPaths([record.originalAbsolute], () => this.barrier.run(fn)),
        });
        await copied.assertSourceUnchanged();
      }
      record.payloadManifest = await scanTree(
        this.native,
        stage.parentHandle,
        stage.name,
        { limits: this.limits, signal },
      );
      const originalRows = new Map(rows.map((row) => [row.relativePath, row]));
      if (
        !copied &&
        (record.payloadManifest.length !== rows.length ||
          record.payloadManifest.some((row) => {
            const original = originalRows.get(row.relativePath);
            return (
              !original ||
              row.content !== original.content ||
              (row.relativePath && row.revision !== original.revision)
            );
          }))
      )
        throw treeConflict();
      record.location.identity = record.payloadManifest[0].identity;
      record.phase = "recoverable";
      record.removalPending = Boolean(copied);
      await stage.parentHandle.sync();
      await this.save(record);
      if (copied) {
        await copied.removeMatchingSource();
        record.removalPending = false;
        await this.save(record);
      }
      return record.id;
    } catch (error) {
      record.issue = { code: fileSystemProblem(error).code, args: {} };
      if (record.phase !== "recoverable") record.phase = "interrupted";
      await this.save(record);
      throw fileSystemProblem(error);
    } finally {
      await closeHandles(stage, selected.parent);
    }
  }
  purge(scope, id, { jobId, confirmation, signal } = {}) {
    return this.entry(id, async () => {
      this.store.getJob(scope, jobId);
      const record = this.authorized(scope, id);
      const current = await this.observe(record);
      if (
        confirmation?.id !== id ||
        typeof confirmation.revision !== "string" ||
        current.revision !== confirmation.revision ||
        current.availability !== "recoverable"
      )
        throw fileProblem("FILE_TRASH_CONFIRMATION", 409);
      const source = await openTrashPayload(this.native, record);
      try {
        await source.assertAuthority();
        record.phase = "purging";
        await this.barrier.run(() => {
          this.store.clearTrashItems(id);
          this.store.putTrash(record);
        });
        await removeTree(
          this.native,
          source.parent,
          source.name,
          record.payloadManifest,
          {
            limits: this.limits,
            signal,
            mutate: (fn) => this.barrier.run(fn),
            report: ({ entry }) => this.store.putTrashItem(id, entry.relativePath, entry),
          },
        );
        await this.finish(record);
      } finally {
        await source.parent.close();
      }
    });
  }
  async finish(record) {
    await this.barrier.run(async () => {
      for (const location of [
        record.location,
        record.adoptionSource,
        ...(record.extraLocations || []),
      ]) {
        if (!location || location.containerRemoved) continue;
        if (!(await parentMatches(this.native, location.file, location.parentIdentity)))
          throw treeConflict();
        const parent = await openParent(this.native, path.dirname(location.file));
        try {
          await this.native.run("removeEntry", {
            directory: parent.handle,
            name: path.basename(path.dirname(location.file)),
            identity: location.parentIdentity,
            type: "directory",
          });
          await parent.sync();
          location.containerRemoved = true;
          await this.save(record);
        } finally {
          await parent.close();
        }
      }
      if (record.recoveryId) {
        const publication = this.store.getPublication(record.recoveryId);
        if (publication) this.store.putPublication({ ...publication, phase: "resolved" });
      }
      this.store.deleteTrash(record.id);
    });
  }
  restore(scope, id, target, { jobId, expectedRevision, signal } = {}) {
    return this.entry(id, async () => {
      this.store.getJob(scope, jobId);
      const record = this.authorized(scope, id);
      if ((await this.observe(record)).availability !== "recoverable")
        throw treeConflict();
      const selected = await resolveFile(scope, target, {
        followLeaf: false,
        allowMissingLeaf: true,
      });
      assertFileMutationTarget(scope, selected);
      this.assertProtected(selected.absolute);
      await this.publisher.assertExpected(scope, target, expectedRevision);
      const stage = await this.publisher.stage(scope, target, {
        jobId,
        type: record.type,
      });
      const originalLocation = { ...record.location };
      record.phase = "restore_pending";
      record.restoreSourceLocation = originalLocation;
      record.restoreStage = stage.id;
      let source,
        failure,
        publishedStarted = false;
      try {
        await this.save(record);
        source = await trashAdoptionSource(this.store, this.native, record);
        try {
          await stage.adoptEntry(source);
        } catch (error) {
          if (!["EXDEV", "FILE_CROSS_DEVICE"].includes(error.code)) throw error;
          await copyVerified(
            scope,
            privateTreeSource((native) =>
              openTrashPayload(native, { ...record, location: originalLocation }),
            ),
            stage,
            {
              limits: this.limits,
              signal,
              strictMetadata: true,
              report: ({ entry }) =>
                this.barrier.run(() => {
                  if (entry) this.store.putTrashItem(id, entry.relativePath, entry);
                }),
            },
          );
        }
        record.location = {
          file: stage.file,
          parentIdentity: inodeIdentity(await stage.parentHandle.stat()),
          identity: inodeIdentity(
            await inspect(this.native, stage.parentHandle.handle, stage.name),
          ),
        };
        await this.save(record);
        publishedStarted = true;
        const result = await this.publisher.publish(scope, stage, { expectedRevision });
        if (result.recoveryId) await this.adoptDisplaced(scope, result.recoveryId);
        record.location = originalLocation;
        const remaining = await openTrashPayload(this.native, record).catch(() => null);
        if (remaining) {
          record.restoreRemovalPending = true;
          await this.barrier.run(() => {
            this.store.clearTrashItems(id);
            this.store.putTrash(record);
          });
          try {
            await removeTree(
              this.native,
              remaining.parent,
              remaining.name,
              record.payloadManifest,
              {
                limits: this.limits,
                mutate: (fn) => this.barrier.run(fn),
                report: ({ entry }) =>
                  this.store.putTrashItem(id, entry.relativePath, entry),
              },
            );
          } finally {
            await remaining.parent.close();
          }
        }
        record.restoreRemovalPending = false;
        await this.save(record);
        await this.finish(record);
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        const results = await Promise.allSettled([
          source?.parentHandle.close(),
          !publishedStarted ? this.publisher.release(stage) : Promise.resolve(),
        ]);
        const cleanup = results.find((result) => result.status === "rejected");
        if (!failure && cleanup) throw cleanup.reason;
      }
    });
  }
  adoptDisplaced(scope, recoveryId) {
    return this.entry(recoveryId, async () => {
      const prior = this.store.getTrash(recoveryId);
      if (prior && prior.scopeId !== scope.id) throw treeConflict();
      if (
        prior?.phase === "recoverable" ||
        (prior?.phase === "adoption_pending" &&
          prior.location?.file === prior.centralLocation?.file &&
          prior.location?.identity)
      ) {
        if (
          prior.phase === "adoption_pending" &&
          (prior.location.identity !== prior.sourceManifest?.[0].identity ||
            !prior.payloadManifest)
        )
          throw treeConflict();
        await completeTrashAdoption(this, prior);
        return prior.id;
      }
      if (
        prior &&
        (prior.phase !== "adoption_pending" || prior.adoptionSource?.containerRemoved)
      )
        throw treeConflict();
      const publication = this.store.getPublication(recoveryId);
      if (
        !publication ||
        publication.phase !== "swapped" ||
        publication.document.scopeId !== scope.id
      )
        throw treeConflict();
      const doc = publication.document;
      const record = prior || {
        id: recoveryId,
        jobId: publication.jobId,
        scopeId: scope.id,
        scope: { ...scope },
        originalAbsolute: doc.target,
        originalPath: doc.selectedPath,
        deletedAt: new Date().toISOString(),
        reason: "replaced",
        phase: "adoption_pending",
        recoveryId,
      };
      if (!prior) {
        record.location = {
          file: doc.staged,
          parentIdentity: doc.stageParent,
          identity: doc.displacedIdentity,
        };
        record.adoptionSource = { ...record.location };
        await this.save(record);
      }
      const old = record.adoptionSource;
      if (
        old?.file !== doc.staged ||
        old.parentIdentity !== doc.stageParent ||
        old.identity !== doc.displacedIdentity
      )
        throw treeConflict();
      try {
        const id = await this.captureSource(
          scope,
          privateTreeSource((native) =>
            openTrashPayload(native, { ...record, location: old }),
          ),
          record,
        );
        await completeTrashAdoption(this, record);
        return id;
      } catch (error) {
        record.phase = "adoption_pending";
        await this.save(record);
        throw error;
      }
    });
  }
  retainRenameSource(scope, recoveryId) {
    return this.entry(recoveryId, () => retainRenameSource(this, scope, recoveryId));
  }
  recover() {
    return this.track(() => recoverTrash(this));
  }
  close() {
    this.closed = true;
    return Promise.allSettled([...this.pending]);
  }
}
