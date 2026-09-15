import path from "node:path";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import {
  resolveFile,
  entryRevision,
  validateFileName,
  assertFileMutationTarget,
  fileInputPath,
} from "./file-paths.js";
import { alternateName } from "./file-mutations.js";
import { inodeIdentity } from "./file-stage.js";
import { safeIssue } from "./file-job-handlers.js";
import { UploadGroups } from "./file-upload-groups.js";
import { receiveUploadBytes } from "./file-upload-stream.js";
import { sweepUploads, recoverUploads } from "./file-upload-sweep.js";

function operation(requestId, kind, target, name = null, options = {}) {
  return { requestId, kind, sources: [], target, name, options };
}
export class FileUploads {
  constructor({ jobs, store, publisher, trash, limits }) {
    Object.assign(this, {
      jobs,
      store,
      publisher,
      trash,
      limits,
      barrier: publisher.barrier,
    });
    this.journal = store.uploads;
    this.pending = new Set();
    this.receivers = new Map();
    this.initializing = new Map();
    this.groups = new UploadGroups(this);
    this.closed = false;
    jobs.onSettled = (item) => this.background(this.groups.settled(item));
    jobs.cancelGroup = (scope, id) => this.own(() => this.groups.cancel(scope, id));
    jobs.onCancelled = (scope, id) => {
      const op = store.getOperation(id);
      if (op?.kind === "upload" && !jobs.owns(id))
        this.background(this.groups.settled({ id, scope, operation: op }));
    };
  }
  ensureOpen() {
    if (this.closed || this.jobs.closed) throw fileProblem("FILE_JOBS_CLOSED", 503);
  }
  own(action) {
    try {
      this.ensureOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = Promise.resolve().then(action);
    this.pending.add(result);
    result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
    return result;
  }
  background(result) {
    this.pending.add(result);
    result.then(
      () => this.pending.delete(result),
      (error) => {
        this.pending.delete(result);
        this.failure = error;
      },
    );
  }
  async scope(scope) {
    const fresh = this.jobs.context ? await this.jobs.context(scope.sessionId) : scope;
    if (fresh.id !== scope.id) throw fileProblem("FILE_INVALID_SCOPE", 409);
    if (fresh.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    return fresh;
  }
  createGroup(scope, body) {
    return this.own(async () => {
      scope = await this.scope(scope);
      if (!body || Object.keys(body).some((key) => !["requestId", "path"].includes(key)))
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      const op = operation(
        body.requestId,
        "upload_group",
        fileInputPath(scope, body.path),
      );
      if (this.journal.hasRequest(scope, body.requestId)) {
        const job = await this.jobs.reserve(scope, op);
        return { groupId: job.id, job };
      }
      const selected = await resolveFile(scope, body.path);
      if (!selected.stat.isDirectory()) throw fileProblem("FILE_NOT_DIRECTORY", 400);
      this.trash.assertProtected(selected.absolute);
      const job = await this.jobs.reserve(scope, op, {
        admit: (id) => {
          this.journal.createGroup(id);
          this.journal.save("upload_groups", id, {
            ...this.journal.group(id),
            scope,
            rootIdentity: inodeIdentity(selected.stat),
            rootAbsolute: selected.absolute,
            destinationPath: scope.kind === "global" ? selected.absolute : selected.path,
          });
        },
      });
      return { groupId: job.id, job };
    });
  }
  appendGroup(scope, id, batch) {
    return this.own(async () => {
      scope = await this.scope(scope);
      return this.barrier.run(() => this.journal.append(scope, id, batch));
    });
  }
  commitGroup(scope, id) {
    return this.own(async () => {
      scope = await this.scope(scope);
      await this.barrier.run(() =>
        this.journal.transaction(() => {
          this.jobs.get(scope, id);
          const group = this.journal.group(id);
          if (!group || group.cancelled) throw fileProblem("FILE_INVALID_OPERATION", 409);
          if (group.invalid) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
          group.committed = true;
          group.generation++;
          group.lastActivity = this.store.now();
          this.journal.save("upload_groups", id, group);
        }),
      );
      await this.groups.wake(scope, id);
      return this.jobs.get(scope, id);
    });
  }
  create(scope, body) {
    return this.own(async () => {
      scope = await this.scope(scope);
      if (
        !body ||
        Object.keys(body).some(
          (key) =>
            ![
              "requestId",
              "path",
              "name",
              "bytes",
              "scopeId",
              "groupId",
              "entryId",
            ].includes(key),
        ) ||
        (body.scopeId !== undefined && body.scopeId !== scope.id) ||
        typeof body.path !== "string" ||
        !Number.isSafeInteger(body.bytes) ||
        body.bytes < 0 ||
        Boolean(body.groupId) !== Boolean(body.entryId)
      )
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      validateFileName(body.name);
      if (!body.name.isWellFormed()) throw fileProblem("FILE_INVALID_NAME", 400);
      if (body.bytes > this.limits.uploadBytes || body.bytes > this.limits.jobBytes)
        throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      const op = {
        ...operation(body.requestId, "upload", body.path, body.name, {
          bytes: body.bytes,
        }),
        ...(body.groupId ? { parentJobId: body.groupId, entryId: body.entryId } : {}),
      };
      let created = false;
      const job = await this.jobs.reserve(scope, op, {
        admit: (id, saved) => {
          created = true;
          this.journal.claim(scope, id, saved, (child) => this.jobs.owns(child));
          this.journal.save("uploads", id, { ...this.journal.attempt(id), scope });
        },
      });
      const upload = this.journal.attempt(job.id);
      if (!upload.initialized && !upload.groupId && job.status === "queued") {
        let initial = this.initializing.get(job.id);
        if (!initial) {
          initial = this.initialize(scope, job.id);
          this.initializing.set(job.id, initial);
          initial.finally(() => this.initializing.delete(job.id)).catch(() => {});
        }
        try {
          await initial;
        } catch (error) {
          await this.barrier.run(() => {
            this.jobs.reservations.delete(job.id);
            this.journal.settle(scope, job.id, "failed", safeIssue(error));
          });
          throw error;
        }
      }
      if (created && upload.groupId) await this.groups.wake(scope, upload.groupId);
      return { job: this.jobs.get(scope, job.id), uploadId: job.id };
    });
  }
  async initialize(scope, id) {
    const op = this.store.getOperation(id),
      upload = this.journal.attempt(id);
    const parent = upload.groupId
      ? await this.groups.readyParent(
          scope,
          upload.groupId,
          this.store.getEntry(upload.groupId, upload.entryId),
        )
      : await resolveFile(scope, op.target);
    const target = upload.groupId
      ? this.store.getEntry(upload.groupId, upload.entryId).path
      : path.join(scope.kind === "global" ? parent.absolute : parent.path, op.name);
    const selected = await resolveFile(scope, target, {
      followLeaf: false,
      allowMissingLeaf: true,
    });
    assertFileMutationTarget(scope, selected);
    this.trash.assertProtected(selected.absolute);
    await this.barrier.run(() => {
      this.journal.save("uploads", id, {
        ...this.journal.attempt(id),
        initialized: true,
        path: selected.path,
        absolute: selected.absolute,
        expectedRevision: selected.stat
          ? entryRevision(selected.stat, selected.linkIdentity)
          : null,
        parentIdentity: inodeIdentity(parent.stat),
        parentPath: parent.path,
        parentAbsolute: parent.absolute,
      });
      this.journal.updateRow(id, { path: selected.path });
    });
  }
  async validateParent(scope, upload) {
    const parent = upload.groupId
      ? await this.groups.readyParent(
          scope,
          upload.groupId,
          this.store.getEntry(upload.groupId, upload.entryId),
        )
      : await resolveFile(scope, upload.parentPath);
    if (
      inodeIdentity(parent.stat) !== upload.parentIdentity ||
      parent.absolute !== upload.parentAbsolute
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
  }
  receive(scope, id, readable, { signal, declaredBytes, onInputFailure } = {}) {
    return this.own(async () => {
      scope = await this.scope(scope);
      const job = this.jobs.get(scope, id),
        upload = this.journal.attempt(id);
      if (!upload) throw fileProblem("FILE_INVALID_OPERATION", 400);
      if (
        declaredBytes !== undefined &&
        (!Number.isSafeInteger(declaredBytes) || declaredBytes !== upload.bytes)
      )
        throw fileProblem("FILE_UPLOAD_LENGTH", 400);
      if (upload.completed || upload.skipped) {
        readable.resume();
        return job;
      }
      if (this.receivers.has(id)) {
        readable.resume();
        return this.receivers.get(id).done;
      }
      if (upload.sweeping || job.status !== "queued" || !this.jobs.reservations.has(id))
        throw fileProblem("FILE_UPLOAD_PENDING", 409);
      const controller = new AbortController(),
        combined = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
      const pending = Promise.withResolvers();
      this.receivers.set(id, { controller, done: pending.promise });
      pending.promise.catch(() => {});
      try {
        if (upload.groupId) {
          await this.groups.wake(scope, upload.groupId);
          await this.jobs.join(scope, upload.groupId);
          const row = this.store.getEntry(upload.groupId, upload.entryId);
          const parent = this.journal.rowByPath(
            upload.groupId,
            path.dirname(row.relativePath),
          );
          if (parent && parent.status !== "completed")
            throw fileProblem("FILE_UPLOAD_PARENT", 409);
          await this.initialize(scope, id);
        }
        combined.throwIfAborted();
        const done = this.jobs.runReserved(scope, id, (context) =>
          this.run(context, readable, combined, onInputFailure),
        );
        const abort = () => {
          this.jobs.active.get(id)?.controller.abort(combined.reason);
          if (!this.jobs.closed) this.background(this.jobs.cancel(scope, id));
        };
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
        try {
          const result = await done;
          pending.resolve(result);
          return result;
        } finally {
          combined.removeEventListener("abort", abort);
        }
      } catch (error) {
        pending.reject(error);
        throw error;
      } finally {
        this.receivers.delete(id);
      }
    });
  }
  async run(context, readable, externalSignal, onInputFailure) {
    const { scope, jobId, conflict } = context;
    const signal = AbortSignal.any([context.signal, externalSignal]);
    let upload = this.journal.attempt(jobId),
      target = upload.path,
      expectedRevision = upload.expectedRevision;
    let stage;
    try {
      signal.throwIfAborted();
      if (!upload.initialized) throw fileProblem("FILE_UPLOAD_PARENT", 409);
      await this.validateParent(scope, upload);
      await this.publisher.assertExpected(scope, target, expectedRevision, {
        expectedTarget: upload.absolute,
      });
      if (expectedRevision !== null) {
        const selected = await resolveFile(scope, target, { followLeaf: false });
        const choice = await conflict({
          type: "name",
          source: null,
          target,
          sourceType: "file",
          targetType: selected.stat.isFile()
            ? "file"
            : selected.stat.isDirectory()
              ? "directory"
              : "symlink",
          sourceRevision: null,
          targetRevision: expectedRevision,
          choices: selected.stat.isFile()
            ? ["replace", "skip", "keep_both", "cancel"]
            : ["skip", "keep_both", "cancel"],
          revalidate: async () => {
            await this.scope(scope);
            await this.publisher.assertExpected(scope, target, expectedRevision, {
              expectedTarget: upload.absolute,
            });
          },
        });
        if (choice.decision === "skip") {
          await this.barrier.run(() => this.journal.settle(scope, jobId, "skipped"));
          readable.resume();
          return;
        }
        if (choice.decision === "cancel") throw fileProblem("FILE_CANCELLED", 409);
        if (choice.decision === "keep_both") {
          const parent = path.dirname(target),
            name = path.basename(target);
          let index = 2;
          do {
            target = path.join(parent, alternateName(name, index++));
          } while (
            (
              await resolveFile(scope, target, {
                followLeaf: false,
                allowMissingLeaf: true,
              })
            ).stat
          );
          expectedRevision = null;
          await this.barrier.run(() => {
            upload = {
              ...this.journal.attempt(jobId),
              path: target,
              absolute: path.join(path.dirname(upload.absolute), path.basename(target)),
              expectedRevision,
            };
            this.journal.save("uploads", jobId, upload);
            this.journal.updateRow(jobId, { path: target });
          });
        }
      }
      signal.throwIfAborted();
      stage = await this.publisher.stage(scope, target, { jobId, upload: true });
      await receiveUploadBytes(
        this,
        scope,
        jobId,
        readable,
        stage,
        signal,
        onInputFailure,
      );
      signal.throwIfAborted();
      const result = await this.publisher.publish(scope, stage, {
        expectedRevision,
        refreshScope: async () => {
          await this.scope(scope);
          await this.validateParent(scope, upload);
        },
        beforeMutation: () => signal.throwIfAborted(),
      });
      if (result.recoveryId) await this.trash.adoptDisplaced(scope, result.recoveryId);
      await this.barrier.run(() => this.journal.finish(scope, jobId));
    } catch (cause) {
      if (stage && !this.journal.attempt(jobId).published)
        await this.publisher.discard(stage).catch(() => {});
      throw fileSystemProblem(cause);
    }
  }
  recover() {
    return recoverUploads(this);
  }
  sweep(now = this.store.now()) {
    return this.own(() => sweepUploads(this, now));
  }
  start() {
    if (this.closed) return;
    this.timer = setInterval(() => this.background(this.sweep()), 3600000);
    this.timer.unref();
  }
  stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const receiver of this.receivers.values()) receiver.controller.abort();
  }
  async close() {
    this.stop();
    await Promise.allSettled([...this.pending]);
    if (this.failure) throw this.failure;
  }
}
