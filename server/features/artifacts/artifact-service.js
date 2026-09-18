import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ArtifactStore } from "./artifact-store.js";
import { copyArtifactSource } from "./artifact-source.js";
import {
  artifactError,
  artifactFailure,
  artifactLimits,
  artifactId,
} from "./artifact-errors.js";
export class ArtifactService {
  constructor({
    dataDir,
    limits,
    sessionExists,
    onError = () => {},
    pollMs = 60000,
    clock = () => new Date(),
    barrier,
  }) {
    this.barrier = barrier;
    this.store = new ArtifactStore(dataDir);
    this.limits = { ...artifactLimits, ...limits };
    this.sessionExists = sessionExists;
    this.onError = onError;
    this.clock = clock;
    this.queue = Promise.resolve();
    this.pending = new Set();
    this.retiring = new Set();
    this.deleting = new Set();
    this.closed = false;
    this.ready = this.reconcile();
    if (pollMs) {
      this.timer = setInterval(() => this.reconcile().catch(onError), pollMs);
      this.timer.unref();
    }
  }
  serial(operation) {
    if (this.closed) return Promise.reject(artifactError("ARTIFACT_UNAVAILABLE", 503));
    const enqueue = () => {
      const next = this.queue.then(operation);
      this.queue = next.catch(() => {});
      return next;
    };
    const next = this.barrier ? this.barrier.run(enqueue) : enqueue();
    this.pending ??= new Set();
    this.pending.add(next);
    next.finally(() => this.pending.delete(next)).catch(() => {});
    return next;
  }

  record(id) {
    if (!artifactId(id)) throw artifactError("ARTIFACT_NOT_FOUND", 404);
    const record = Object.hasOwn(this.store.state.records, id)
      ? this.store.state.records[id]
      : null;
    if (!record || record.deleted || this.deleting.has(id))
      throw artifactError("ARTIFACT_NOT_FOUND", 404);
    return record;
  }
  summary(record) {
    const {
      id,
      projectId,
      sessionId,
      title,
      mediaType,
      sizeBytes,
      createdAt,
      updatedAt,
      pinned,
    } = record;
    return {
      id,
      projectId,
      sessionId,
      title,
      mediaType,
      sizeBytes,
      createdAt,
      updatedAt,
      pinned,
      orphaned:
        this.store.state.retired.includes(sessionId) || !this.sessionExists(sessionId),
    };
  }
  assertSession(context) {
    if (
      !artifactId(context.sessionId) ||
      !artifactId(context.projectId) ||
      this.retiring.has(context.sessionId) ||
      this.store.state.retired.includes(context.sessionId) ||
      !this.sessionExists(context.sessionId)
    )
      throw artifactError("ARTIFACT_SESSION_GONE", 409);
  }
  publish(context, input, revalidate) {
    return this.serial(async () => {
      let folder;
      try {
        this.assertSession(context);
        if (
          !artifactId(input.requestId) ||
          typeof input.title !== "string" ||
          !input.title.trim() ||
          input.title.length > 100 ||
          /[\x00-\x1f]/.test(input.title)
        )
          throw artifactError("ARTIFACT_INVALID_INPUT");
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              context.projectId,
              input.title,
              input.sourcePath,
              input.entrypoint || null,
              input.artifactId || null,
            ]),
          )
          .digest("hex");
        const key = `${context.sessionId}:${input.requestId}`;
        const receipt = this.store.state.receipts[key];
        if (receipt) {
          if (receipt.fingerprint !== fingerprint)
            throw artifactError("ARTIFACT_CONFLICT", 409);
          this.record(receipt.result.id);
          await revalidate();
          return receipt.result;
        }
        if (Object.keys(this.store.state.receipts).length >= 10000)
          throw artifactError("ARTIFACT_LIMIT_EXCEEDED", 413);
        const previous = input.artifactId ? this.record(input.artifactId) : null;
        if (
          previous &&
          (previous.sessionId !== context.sessionId ||
            previous.projectId !== context.projectId)
        )
          throw artifactError("ARTIFACT_ACCESS_DENIED", 403);
        const id = previous?.id || randomUUID(),
          generation = randomUUID();
        folder = path.join(this.store.generations, generation);
        await fs.mkdir(folder, { mode: 0o700 });
        const usage = await this.store.usage();
        const copied = await copyArtifactSource(
          context,
          input,
          folder,
          this.limits,
          this.limits.totalBytes - usage.usedBytes,
        );
        await revalidate();
        this.assertSession(context);
        if (previous) this.record(previous.id);
        const now = this.clock().toISOString();
        const record = {
          id,
          generation,
          projectId: context.projectId,
          sessionId: context.sessionId,
          title: input.title.trim(),
          ...copied,
          pinned: previous?.pinned || false,
          createdAt: previous?.createdAt || now,
          updatedAt: now,
        };
        const result = this.summary(record);
        const next = structuredClone(this.store.state);
        next.records[id] = record;
        next.receipts[key] = { fingerprint, result };
        const metadataBytes = Buffer.byteLength(JSON.stringify(next, null, 2)) + 1;
        const oldMetadata = (await fs.stat(this.store.file).catch(() => ({ size: 0 })))
          .size;
        if (
          (await this.store.usage()).usedBytes - oldMetadata + metadataBytes * 2 >
          this.limits.totalBytes
        )
          throw artifactError("ARTIFACT_LIMIT_EXCEEDED", 413);
        await this.store.syncGeneration(folder);
        await revalidate();
        this.assertSession(context);
        if (previous) this.record(previous.id);
        this.store.save(next);
        folder = null;
        await this.store.cleanup(this.onError);
        return result;
      } catch (error) {
        throw artifactFailure(error);
      } finally {
        if (
          folder &&
          !Object.values(this.store.state.records).some(
            (record) => record.generation === path.basename(folder),
          )
        )
          await fs.rm(folder, { recursive: true, force: true }).catch(this.onError);
      }
    });
  }
  get(id) {
    return this.serial(() => this.summary(this.record(id)));
  }
  list({ sessionId, projectId, page = 1 } = {}) {
    return this.serial(() => {
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 100000 ||
        (sessionId !== undefined && !artifactId(sessionId)) ||
        (projectId !== undefined && !artifactId(projectId))
      )
        throw artifactError("ARTIFACT_INVALID_INPUT");
      const records = Object.values(this.store.state.records)
        .filter(
          (r) =>
            !r.deleted &&
            !this.deleting.has(r.id) &&
            (!sessionId || r.sessionId === sessionId) &&
            (!projectId || r.projectId === projectId),
        )
        .sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        );
      return {
        items: records.slice((page - 1) * 20, page * 20).map((r) => this.summary(r)),
        page,
        total: records.length,
      };
    });
  }
  snapshot(id) {
    return this.serial(async () => {
      const record = this.record(id),
        files = [];
      for (const file of record.files) {
        const bytes = await fs.readFile(
          path.join(this.store.generations, record.generation, file.stored),
        );
        files.push({
          path: file.path,
          mediaType: file.mediaType,
          base64: bytes.toString("base64"),
        });
      }
      return {
        artifact: this.summary(record),
        generation: record.generation,
        entrypoint: record.entrypoint,
        files,
      };
    });
  }
  setPinned(id, pinned) {
    return this.serial(async () => {
      if (typeof pinned !== "boolean") throw artifactError("ARTIFACT_INVALID_INPUT");
      const record = this.record(id);
      const next = structuredClone(this.store.state);
      if (!pinned && this.summary(record).orphaned)
        next.records[id] = { id, sessionId: record.sessionId, deleted: true };
      else next.records[id].pinned = pinned;
      this.store.save(next);
      await this.store.cleanup(this.onError);
      return next.records[id].deleted ? null : this.summary(next.records[id]);
    });
  }
  delete(id) {
    if (!artifactId(id)) return Promise.reject(artifactError("ARTIFACT_NOT_FOUND", 404));
    this.deleting.add(id);
    return this.serial(async () => {
      const record = Object.hasOwn(this.store.state.records, id)
        ? this.store.state.records[id]
        : null;
      if (!record) throw artifactError("ARTIFACT_NOT_FOUND", 404);
      const next = structuredClone(this.store.state);
      next.records[id] = { id, sessionId: record.sessionId, deleted: true };
      this.store.save(next);
      await this.store.cleanup(this.onError);
    }).finally(() => this.deleting.delete(id));
  }
  retireSession(sessionId) {
    this.retiring.add(sessionId);
    return this.serial(async () => {
      const next = structuredClone(this.store.state);
      if (!next.retired.includes(sessionId)) next.retired.push(sessionId);
      for (const record of Object.values(next.records))
        if (record.sessionId === sessionId && !record.pinned)
          next.records[record.id] = { id: record.id, sessionId, deleted: true };
      this.store.save(next);
      await this.store.cleanup(this.onError);
    }).finally(() => this.retiring.delete(sessionId));
  }
  usage() {
    return this.serial(async () => ({
      ...(await this.store.usage()),
      limitBytes: this.limits.totalBytes,
    }));
  }
  reconcile() {
    return this.serial(async () => {
      const next = structuredClone(this.store.state);
      let changed = false;
      for (const record of Object.values(next.records))
        if (!record.deleted && !this.sessionExists(record.sessionId)) {
          if (!next.retired.includes(record.sessionId)) {
            next.retired.push(record.sessionId);
            changed = true;
          }
          if (!record.pinned) {
            next.records[record.id] = {
              id: record.id,
              sessionId: record.sessionId,
              deleted: true,
            };
            changed = true;
          }
        }
      if (changed) this.store.save(next);
      await this.store.cleanup(this.onError);
    });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.pending]);
  }
}
