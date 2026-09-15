import path from "node:path";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { registerFileJobHandler } from "./file-job-handlers.js";
import { validateTextOperation } from "./file-text-store.js";
import {
  readTextDocument,
  documentMetadata,
  openText,
  writableText,
  decodeText,
  textConflict,
} from "./file-text-reading.js";
import { publicationSnapshot } from "./file-stage.js";
import { copyMetadata } from "./file-metadata.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import { fileInputPath } from "./file-paths.js";

export class FileText {
  constructor({ jobs, store, publisher, trash, limits, context, handlers }) {
    Object.assign(this, { jobs, store, publisher, trash, limits, context });
    this.bodies = new Map();
    this.pending = new Set();
    registerFileJobHandler(handlers, "text_save", (args) => this.write(args), {
      transfer: true,
      validate: validateTextOperation,
    });
  }
  track(action) {
    if (this.closed) return Promise.reject(fileProblem("FILE_JOBS_CLOSED", 503));
    const promise = Promise.resolve().then(action);
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  read(scope, target) {
    return this.track(() => readTextDocument(this.publisher, scope, target, this.limits));
  }
  metadata(scope, target) {
    return this.track(() => documentMetadata(this.publisher, scope, target));
  }
  async fresh(scope) {
    const current = await this.context(scope.sessionId);
    if (current.id !== scope.id) throw fileProblem("FILE_INVALID_SCOPE", 409);
    if (current.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    return current;
  }
  save(scope, target, value, { revision, requestId } = {}) {
    // Capture the attempt before any await or queued work can observe a changed draft.
    const bytes =
      value instanceof Uint8Array && value.length <= this.limits.textBytes
        ? Buffer.from(value)
        : null;
    return this.track(async () => {
      if (
        revision !== null &&
        (typeof revision !== "string" || !/^d1:[a-f0-9]{64}$/.test(revision))
      )
        throw fileProblem("FILE_TEXT_PRECONDITION", 400);
      if (!(value instanceof Uint8Array))
        throw fileProblem("FILE_INVALID_OPERATION", 400);
      if (!bytes) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      decodeText(bytes);
      scope = await this.fresh(scope);
      if (
        typeof target === "string" &&
        (target === "." || target.endsWith("/") || target.endsWith("/."))
      )
        throw fileProblem("FILE_NOT_DIRECTORY", 400);
      target = fileInputPath(scope, target);
      const operation = {
        kind: "text_save",
        requestId,
        sources: [],
        target,
        name: null,
        options: {
          revision,
          bytes: bytes.length,
          hash: createHash("sha256").update(bytes).digest("hex"),
        },
      };
      let registered, job;
      try {
        job = await this.jobs.start(scope, operation, {
          admit: (id) => {
            this.store.text.put(id, { scope: { ...scope } });
            registered = id;
            this.bodies.set(id, bytes);
          },
        });
        await this.jobs.join(scope, job.id);
        const result = await this.publisher.barrier.run(() =>
          this.store.text.finish(scope, job.id),
        );
        if (result) return result;
        const current = this.jobs.get(scope, job.id);
        const code =
          current.issue?.code ||
          (current.status === "cancelled" ? "FILE_CANCELLED" : "FILE_INTERRUPTED");
        const status = [
          "FILE_READ_ONLY",
          "FILE_ACCESS_DENIED",
          "FILE_OUTSIDE_SCOPE",
          "FILE_PROTECTED_PATH",
        ].includes(code)
          ? 403
          : code === "FILE_LIMIT_EXCEEDED"
            ? 413
            : code === "FILE_UNSUPPORTED_TYPE"
              ? 415
              : code === "FILE_WRITE_UNSUPPORTED"
                ? 503
                : 409;
        throw fileProblem(code, status);
      } finally {
        const id = job?.id || registered;
        if (id && !this.jobs.owns(id)) this.bodies.delete(id);
      }
    });
  }
  async write({ scope, operation, jobId, signal }) {
    const bytes = this.bodies.get(jobId);
    if (
      !bytes ||
      !validateTextOperation(operation) ||
      bytes.length !== operation.options.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== operation.options.hash
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    let source,
      stage,
      publicationStarted = false;
    try {
      signal.throwIfAborted();
      scope = await this.fresh(scope);
      const revision = operation.options.revision;
      if (revision !== null) {
        try {
          source = await openText(this.publisher, scope, operation.target);
        } catch (error) {
          if (error.code === "FILE_NOT_FOUND") throw textConflict();
          throw error;
        }
        const observed = await publicationSnapshot(
          source.handle,
          source.selected.linkIdentity,
          { maxBytes: this.limits.textBytes, signal },
        );
        if (observed.revision !== revision) throw textConflict();
        await writableText(this.publisher, scope, source);
      } else {
        await this.publisher.assertExpected(scope, operation.target, null, {
          followLeaf: true,
        });
      }
      signal.throwIfAborted();
      stage = await this.publisher.stage(scope, operation.target, {
        jobId,
        textSave: true,
        followLeaf: true,
      });
      await stage.handle.writeFile(bytes);
      await stage.handle.sealWrites();
      if (source) {
        await copyMetadata(source.handle, stage.handle, {
          strictOwnership: true,
          preserveTimes: false,
        });
        await writableText(this.publisher, scope, source);
      }
      signal.throwIfAborted();
      publicationStarted = true;
      const published = await this.publisher.publish(scope, stage, {
        expectedRevision: revision,
        refreshScope: () => this.fresh(scope),
        beforeMutation: async () => {
          signal.throwIfAborted();
          if (source)
            await writableText(this.publisher, scope, source, { metadata: false });
          else {
            try {
              await fs.access(
                path.dirname(stage.target),
                constants.W_OK | constants.X_OK,
              );
            } catch (error) {
              throw fileSystemProblem(error);
            }
          }
        },
      });
      if (published.recoveryId)
        await this.trash.adoptDisplaced(scope, published.recoveryId);
      // Successful publication/adoption remains success even if cancellation arrived late.
      const result = await this.publisher.barrier.run(() =>
        this.store.text.finish(scope, jobId),
      );
      if (!result) throw fileProblem("FILE_INTERRUPTED", 409);
      return result;
    } catch (error) {
      if (stage && !publicationStarted) {
        try {
          await this.publisher.checkpointTextCleanup(stage, bytes);
          await this.publisher.discard(stage);
        } catch {
          await this.publisher.release(stage).catch(() => {});
        }
      }
      throw error;
    } finally {
      await source?.close();
    }
  }
  async recover() {
    let after = "";
    for (;;) {
      const rows = this.store.db
        .prepare(
          "SELECT id FROM jobs WHERE kind='text_save' AND id>? ORDER BY id LIMIT 200",
        )
        .all(after);
      if (!rows.length) break;
      for (const row of rows) {
        const saved = this.store.text.get(row.id);
        if (saved?.scope && saved.result && !saved.complete) {
          const record = this.store.getPublication(saved.publicationId);
          if (record?.phase === "swapped") {
            try {
              await this.trash.adoptDisplaced(saved.scope, record.id);
            } catch {
              continue;
            } // Existing proof/journal remains pinned for later recovery.
          }
          await this.publisher.barrier.run(() =>
            this.store.text.finish(saved.scope, row.id),
          );
        }
      }
      after = rows.at(-1).id;
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    this.bodies.clear();
  }
}
