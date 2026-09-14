import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileProblem } from "./file-errors.js";
import { resolveFile, entryRevision } from "./file-paths.js";
import { closeHandles, inodeIdentity } from "./file-stage.js";
import { registerFileJobHandler } from "./file-job-handlers.js";
import { alternateName } from "./file-mutations.js";
import {
  archiveManifest,
  assertArchiveManifest,
  assertRequiredArchiveSources,
  rejectArchiveRecursion,
} from "./file-archive-plan.js";
import { validateArchiveOperation } from "./file-archive-paths.js";
import { writeArchive } from "./file-archive-stream.js";
import {
  discardArchivePayload,
  openArchiveArtifact,
} from "./file-archive-publication.js";
import { attachmentHeaders, ownedDownloadBytes } from "./file-downloads.js";
export { openCheckedArchiveStream } from "./file-archive-stream.js";

export class FileArchives {
  constructor({ jobs, store, publisher, trash, limits }) {
    Object.assign(this, {
      jobs,
      store,
      publisher,
      trash,
      limits,
      barrier: publisher.barrier,
      journal: store.archives,
    });
    this.claims = new Map();
    this.sweeping = new Set();
    this.closed = false;
    jobs.beforePrune = () => this.sweep();
  }
  async fresh(scope, mode) {
    const current = this.jobs.context ? await this.jobs.context(scope.sessionId) : scope;
    if (current.id !== scope.id) throw fileProblem("FILE_INVALID_SCOPE", 409);
    if (mode === "file" && current.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    return current;
  }
  async createZip(context) {
    const { operation, signal, jobId, conflict } = context;
    const mode = operation.options.output;
    let scope = await this.fresh(context.scope, mode),
      plan,
      required;
    for (;;) {
      plan = await archiveManifest(this, { ...context, scope });
      if (required) assertRequiredArchiveSources(required, plan);
      required ||= plan;
      await this.barrier.run(() =>
        this.journal.plan(scope, jobId, {
          ...plan,
          mode,
          target: null,
          name: operation.name || "archive.zip",
        }),
      );
      await context.report({ totalBytes: plan.bytes, totalEntries: plan.rows.length });
      if (!plan.omissions) break;
      await conflict({
        type: "archive_links",
        manifestVersion: plan.manifestVersion,
        choices: ["skip_links", "cancel"],
        revalidate: () => this.fresh(scope, mode),
      });
      signal.throwIfAborted();
      scope = await this.fresh(scope, mode);
      const current = await archiveManifest(this, { ...context, scope });
      assertRequiredArchiveSources(plan, current);
      if (current.manifestVersion !== plan.manifestVersion) continue;
      await this.barrier.run(() => this.journal.consent(jobId, plan.manifestVersion));
      break;
    }
    let target,
      validateParent = async () => {},
      expectedRevision = null;
    if (mode === "download") target = this.journal.target(scope, jobId);
    else {
      const parent = await resolveFile(scope, operation.target);
      if (!parent.stat.isDirectory()) throw fileProblem("FILE_NOT_DIRECTORY", 400);
      validateParent = async () => {
        const current = await resolveFile(
          await this.fresh(scope, mode),
          operation.target,
        );
        if (
          current.absolute !== parent.absolute ||
          current.linkIdentity !== parent.linkIdentity ||
          inodeIdentity(current.stat) !== inodeIdentity(parent.stat)
        )
          throw fileProblem("FILE_PATH_CHANGED", 409);
      };
      let name = operation.name,
        suffix = 1;
      for (;;) {
        target = path.join(parent.path, name);
        const selected = await resolveFile(scope, target, {
          followLeaf: false,
          allowMissingLeaf: true,
        });
        if (!selected.stat) break;
        const revision = entryRevision(selected.stat, selected.linkIdentity);
        const choices = selected.stat.isFile()
          ? ["replace", "keep_both", "skip", "cancel"]
          : ["keep_both", "skip", "cancel"];
        const decision = await conflict({
          type: "exists",
          path: selected.path,
          target: selected.path,
          revision,
          choices,
          sourceType: "file",
          targetType: selected.stat.isFile()
            ? "file"
            : selected.stat.isDirectory()
              ? "directory"
              : selected.stat.isSymbolicLink()
                ? "symlink"
                : "special",
          revalidate: async () => {
            await validateParent();
            await this.publisher.assertExpected(scope, target, revision);
          },
        });
        signal.throwIfAborted();
        scope = await this.fresh(scope, mode);
        if (decision.decision === "skip") {
          await this.barrier.run(() => this.journal.skip(jobId));
          return;
        }
        if (decision.decision === "replace") {
          expectedRevision = revision;
          break;
        }
        name = alternateName(operation.name, ++suffix);
      }
    }
    rejectArchiveRecursion(
      plan.rows,
      mode === "download"
        ? target
        : (
            await resolveFile(scope, target, {
              followLeaf: false,
              allowMissingLeaf: true,
            })
          ).absolute,
    );
    await assertArchiveManifest(this, { ...context, scope }, plan);
    await validateParent();
    await this.barrier.run(() => {
      const archive = this.journal.get(jobId);
      archive.target = target;
      this.journal.save(jobId, archive);
    });
    let stage;
    try {
      signal.throwIfAborted();
      stage = await this.publisher.stage(scope, target, { jobId, archive: true });
      const proof = await writeArchive(this, { ...context, scope }, plan, stage);
      await assertArchiveManifest(this, { ...context, scope }, plan);
      await this.fresh(scope, mode);
      signal.throwIfAborted();
      await this.publisher.checkpointArchive(stage, proof, {
        signal,
        validate: async () => {
          await assertArchiveManifest(this, { ...context, scope }, plan);
          await this.fresh(scope, mode);
          await validateParent();
        },
      });
      if (mode === "download") {
        await this.publisher.finishArchive(stage, {
          signal,
          validate: () => this.fresh(scope, mode),
        });
        await this.publisher.release(stage);
        stage = null;
      } else {
        const result = await this.publisher.publish(scope, stage, {
          expectedRevision,
          refreshScope: async () => {
            await this.fresh(scope, mode);
            await validateParent();
          },
          beforeMutation: () => signal.throwIfAborted(),
        });
        stage = null;
        if (result.recoveryId) await this.trash.adoptDisplaced(scope, result.recoveryId);
        await this.barrier.run(() => this.journal.finish(jobId));
      }
    } finally {
      if (stage) {
        try {
          await this.publisher.discard(stage);
        } catch {
          await this.publisher.release(stage).catch(() => {});
        }
      }
    }
  }
  async downloadJobArtifact(scope, jobId, response, { signal } = {}) {
    let claimed = false;
    try {
      await this.barrier.run(() => {
        if (this.closed) throw fileProblem("FILE_JOBS_CLOSED", 503);
        const job = this.store.getJob(scope, jobId),
          archive = this.journal.get(jobId);
        if (
          job.kind !== "archive" ||
          this.store.getOperation(jobId)?.options.output !== "download"
        )
          throw fileProblem("FILE_NOT_FOUND", 404);
        if (!archive) throw fileProblem("FILE_ARCHIVE_PENDING", 409);
        const record =
          archive.publicationId && this.store.getPublication(archive.publicationId);
        if (archive.completed && record?.document.archiveDiscarded)
          throw fileProblem("FILE_NOT_FOUND", 404);
        if (
          job.status !== "completed" ||
          !archive.completed ||
          record?.phase !== "artifact" ||
          !record.document.archiveCompleted ||
          this.sweeping.has(jobId)
        )
          throw fileProblem("FILE_ARCHIVE_PENDING", 409);
        this.claims.set(jobId, (this.claims.get(jobId) || 0) + 1);
        claimed = true;
      });
      await this.jobs.runDirectTransfer(
        scope,
        async ({ scope: current, signal: admitted }) => {
          admitted.throwIfAborted();
          const archive = this.journal.get(jobId),
            record = this.store.getPublication(archive.publicationId);
          this.store.getJob(current, jobId);
          const opened = await openArchiveArtifact(
            this.publisher.native,
            record,
            admitted,
          );
          try {
            admitted.throwIfAborted();
            attachmentHeaders(response, archive.name, opened.stat.size);
            await pipeline(
              Readable.from(ownedDownloadBytes(opened.handle, opened.stat, admitted)),
              response,
              { signal: admitted },
            );
          } finally {
            await closeHandles(opened.handle, opened.parent, opened.targetParent);
          }
        },
        { signal },
      );
    } finally {
      if (claimed)
        await this.barrier.run(() => {
          const count = this.claims.get(jobId) - 1;
          if (count) this.claims.set(jobId, count);
          else this.claims.delete(jobId);
        });
    }
  }
  async recover() {
    for (let cursor = ""; ;) {
      const rows = this.journal.page(cursor);
      if (!rows.length) break;
      for (const row of rows) {
        if (row.published) {
          const record = this.store.getPublication(row.publicationId);
          if (row.mode === "file" && record?.phase === "swapped")
            await this.trash.adoptDisplaced(row.scope, record.id).catch(() => {});
          await this.barrier.run(() => this.journal.finish(row.id));
        } else if (row.publicationId) {
          const record = this.store.getPublication(row.publicationId);
          if (["staging", "interrupted"].includes(record?.phase))
            await discardArchivePayload(this.publisher, record).catch(() => {});
        }
      }
      cursor = rows.at(-1).id;
    }
  }
  sweep(now = this.store.now()) {
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this.sweepArtifacts(now).finally(() => {
      this.sweepPromise = null;
    });
    return this.sweepPromise;
  }
  async sweepArtifacts(now) {
    for (let cursor = ""; !this.closed;) {
      const page = this.journal.page(cursor);
      if (!page.length) break;
      for (const archive of page) {
        if (this.closed) return;
        const claimed = await this.barrier.run(() => {
          const current = this.journal.get(archive.id);
          if (
            !current?.completed ||
            current.mode !== "download" ||
            now - current.completedAt < this.limits.jobsRetentionMs ||
            this.claims.has(archive.id) ||
            this.jobs.owns(archive.id)
          )
            return false;
          this.sweeping.add(archive.id);
          return true;
        });
        if (!claimed) continue;
        try {
          await discardArchivePayload(
            this.publisher,
            this.store.getPublication(archive.publicationId),
            { artifact: true },
          );
        } catch (error) {
          if (!error.code?.startsWith("FILE_")) throw error;
        } finally {
          this.sweeping.delete(archive.id);
        }
      }
      cursor = page.at(-1).id;
    }
  }
  stop() {
    this.closed = true;
  }
  async close() {
    this.stop();
    await this.sweepPromise;
  }
}
export function createZip(context) {
  return context.archives.createZip(context);
}
export function registerArchiveHandlers(handlers, archives) {
  registerFileJobHandler(handlers, "archive", (context) => archives.createZip(context), {
    public: true,
    transfer: true,
    readOnly: (operation) => operation.options.output === "download",
    validate: validateArchiveOperation,
  });
}
