import { randomUUID } from "node:crypto";
import { fileProblem } from "./file-errors.js";
import { terminalStates } from "./file-schema.js";
import {
  handlerPolicy,
  validateOperation,
  progressPatch,
  projectConflict,
  safeIssue,
} from "./file-job-handlers.js";

function cancellationPatch(job) {
  return {
    conflict: null,
    ...(job.conflict
      ? {
          decision: {
            conflictId: job.conflict.id,
            decision: "cancel",
            applyToRemaining: false,
          },
        }
      : {}),
  };
}

/** Owns queued admission, handlers, conflict waits and the private store lifecycle. */
export class FileJobs {
  constructor({
    store,
    locks,
    barrier,
    limits,
    handlers,
    now = Date.now,
    context,
    beforeStoreClose = async () => {},
  }) {
    Object.assign(this, {
      store,
      locks,
      barrier,
      limits,
      handlers,
      now,
      context,
      beforeStoreClose,
    });
    this.pending = [];
    this.workers = new Set();
    this.active = new Map();
    this.reservations = new Map();
    this.transfers = 0;
    this.closed = false;
    this.pruneTimer = setInterval(() => {
      this.barrier
        .run(() => {
          if (!this.closed) this.store.prune(this.now());
        })
        .catch(() => {});
    }, 3600000);
    this.pruneTimer.unref();
  }
  ensureOpen() {
    if (this.closed) throw fileProblem("FILE_JOBS_CLOSED", 503);
  }
  get(scope, id) {
    return this.store.getJob(scope, id);
  }
  list(scope, cursor) {
    return this.store.listJobs(scope, cursor);
  }
  entries(scope, id, cursor) {
    return this.store.listEntries(scope, id, cursor);
  }
  async start(scope, operation, { publicOnly = false } = {}) {
    this.ensureOpen();
    validateOperation(operation);
    operation = structuredClone(operation);
    const handler = this.handlers.get(operation.kind),
      policy = handlerPolicy(handler, operation.kind);
    if (
      !handler ||
      (publicOnly && (!policy.public || operation.parentJobId || operation.entryId))
    )
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    if (policy.validate && policy.validate(operation) !== true)
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    if (scope.readOnly && !policy.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    const { job, created } = await this.barrier.run(() => {
      this.ensureOpen();
      return this.store.request(scope, operation);
    });
    if (created)
      this.enqueue({
        scope,
        job,
        operation: this.store.getOperation(job.id),
        handler,
        policy,
      });
    return job;
  }
  async reserve(scope, operation) {
    this.ensureOpen();
    if (!["upload", "upload_group"].includes(operation?.kind))
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    if (scope.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    validateOperation(operation);
    operation = structuredClone(operation);
    const { job, created } = await this.barrier.run(() => {
      this.ensureOpen();
      return this.store.request(scope, operation);
    });
    if (created)
      this.reservations.set(job.id, {
        scope,
        operation: this.store.getOperation(job.id),
      });
    return job;
  }
  async runReserved(scope, id, handler) {
    this.ensureOpen();
    const job = this.get(scope, id),
      reservation = this.reservations.get(id);
    if (this.active.has(id)) return this.active.get(id).done;
    const queued = this.pending.find((item) => item.job.id === id);
    if (queued) return queued.done;
    if (!reservation || job.status !== "queued" || typeof handler !== "function")
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    this.reservations.delete(id);
    return this.enqueue({
      ...reservation,
      job,
      handler,
      policy: { transfer: true, readOnly: false },
    });
  }
  enqueue(item) {
    const completion = Promise.withResolvers();
    Object.assign(item, {
      ...completion,
      done: completion.promise,
      controller: new AbortController(),
    });
    this.pending.push(item);
    this.dispatch();
    return item.done;
  }
  dispatch() {
    // Explicitly erase inherited live HTTP/path leases before creating handler promises.
    this.barrier.detached(() =>
      this.locks.detached(() => {
        for (const item of [...this.pending]) {
          if (this.closed) break;
          if (item.policy.transfer && this.transfers >= this.limits.transfers) continue;
          this.pending.splice(this.pending.indexOf(item), 1);
          if (item.policy.transfer) this.transfers++;
          this.active.set(item.job.id, item);
          const worker = this.execute(item)
            .then(item.resolve, item.reject)
            .finally(() => {
              this.active.delete(item.job.id);
              this.workers.delete(worker);
              if (item.policy.transfer) this.transfers--;
              this.dispatch();
            });
          this.workers.add(worker);
        }
      }),
    );
  }
  async execute(item) {
    const { job, operation, handler, controller } = item;
    let scope = item.scope;
    try {
      controller.signal.throwIfAborted();
      const running = await this.barrier.run(() =>
        this.store.transition(job.id, "queued", "running"),
      );
      controller.signal.throwIfAborted();
      if (!running) return this.get(item.scope, job.id);
      // Admission may wait behind a snapshot; refresh authority after that wait.
      if (this.context) {
        scope = await this.context(scope.sessionId);
        if (scope.id !== item.scope.id) throw fileProblem("FILE_INVALID_SCOPE", 409);
      }
      if (scope.readOnly && !item.policy.readOnly)
        throw fileProblem("FILE_READ_ONLY", 403);
      controller.signal.throwIfAborted();
      await handler({
        scope,
        operation,
        jobId: job.id,
        signal: controller.signal,
        report: (patch) => this.report(item, patch),
        conflict: (info) => this.conflict(item, info),
      });
      await this.barrier.run(() => {
        const current = this.get(item.scope, job.id);
        if (!terminalStates.includes(current.status))
          this.store.transition(
            job.id,
            current.status,
            controller.signal.aborted ? "cancelled" : "completed",
            { conflict: null },
          );
      });
    } catch (error) {
      await this.barrier.run(() => {
        const current = this.get(item.scope, job.id);
        if (!terminalStates.includes(current.status))
          this.store.transition(
            job.id,
            current.status,
            controller.signal.aborted ? "cancelled" : "failed",
            {
              conflict: null,
              issue: controller.signal.aborted ? null : safeIssue(error),
            },
          );
      });
    }
    return this.get(item.scope, job.id);
  }
  async report(item, patch) {
    item.controller.signal.throwIfAborted();
    const bounded = progressPatch(patch, this.limits, item.operation.kind);
    await this.barrier.run(() =>
      this.store.transition(item.job.id, "running", "running", bounded),
    );
  }
  async conflict(item, info) {
    if (this.barrier.hasLease() || this.locks.hasLease())
      throw new Error("Release file leases before waiting for a conflict.");
    item.controller.signal.throwIfAborted();
    const decision = Promise.withResolvers();
    // Own rejection immediately, even while the journal publication is queued.
    const outcome = decision.promise.then(
      (value) => ({ value }),
      (error) => ({ error, failed: true }),
    );
    const conflict = projectConflict({ ...info, id: randomUUID() });
    // Install the waiter before publishing its identity, so an immediate resolve cannot be lost.
    item.conflict = { ...decision, id: conflict.id };
    const abort = () => decision.reject(item.controller.signal.reason);
    item.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        const published = await this.barrier.run(() =>
          this.store.transition(item.job.id, "running", "waiting_for_conflict", {
            conflict,
          }),
        );
        item.controller.signal.throwIfAborted();
        if (!published) throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      } catch (error) {
        decision.reject(error);
      }
      const result = await outcome;
      if (result.failed) throw result.error;
      item.controller.signal.throwIfAborted();
      return result.value;
    } finally {
      item.controller.signal.removeEventListener("abort", abort);
      item.conflict = null;
    }
  }
  async resolve(scope, id, decision) {
    this.ensureOpen();
    const item = this.active.get(id);
    return this.barrier.run(() => {
      const job = this.get(scope, id);
      if (
        !decision ||
        typeof decision !== "object" ||
        Object.keys(decision).some(
          (key) => !["conflictId", "decision", "applyToRemaining"].includes(key),
        ) ||
        typeof decision.applyToRemaining !== "boolean" ||
        job.status !== "waiting_for_conflict" ||
        !item?.conflict ||
        decision.conflictId !== job.conflict?.id ||
        decision.conflictId !== item.conflict.id ||
        !job.conflict.choices?.includes(decision.decision)
      )
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      const result = this.store.transition(id, "waiting_for_conflict", "running", {
        conflict: null,
        decision,
      });
      item.conflict.resolve({ ...decision });
      return result;
    });
  }
  async cancel(scope, id) {
    this.ensureOpen();
    const job = await this.barrier.run(() => {
      const current = this.get(scope, id);
      if (terminalStates.includes(current.status)) return current;
      return this.store.transition(
        id,
        current.status,
        this.active.has(id) ? "cancelling" : "cancelled",
        cancellationPatch(current),
      );
    });
    this.reservations.delete(id);
    for (const item of this.pending.filter((item) => item.job.id === id)) {
      this.pending.splice(this.pending.indexOf(item), 1);
      item.resolve(job);
    }
    this.active.get(id)?.controller.abort();
    return job;
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.pruneTimer);
    this.closing = (async () => {
      await this.barrier.run(() => {
        for (const item of [...this.pending, ...this.active.values()]) {
          const current = this.get(item.scope, item.job.id);
          if (!terminalStates.includes(current.status))
            this.store.transition(
              item.job.id,
              current.status,
              this.active.has(item.job.id) ? "cancelling" : "cancelled",
              cancellationPatch(current),
            );
        }
        for (const id of this.reservations.keys())
          this.store.transition(id, "queued", "interrupted", {});
      });
      for (const item of this.pending.splice(0))
        item.resolve(this.get(item.scope, item.job.id));
      this.reservations.clear();
      for (const item of this.active.values()) item.controller.abort();
      await Promise.allSettled([...this.workers]);
      try {
        await this.beforeStoreClose();
      } finally {
        await this.barrier.run(() => this.store.close());
      }
    })();
    return this.closing;
  }
}
