import { randomUUID } from "node:crypto";
import { isSftpProblem, sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";
import { insideRoot } from "./sftp-remote-paths.js";

const STATES = new Set(["completed", "failed", "cancelled", "revoked"]);
const PROGRESS_MS = 1000;
const progressKeys = ["files", "filesDone", "bytes", "bytesDone", "current"];

function view(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    summary: job.summary,
    state: job.state,
    progress: { ...job.progress },
    ...(job.result ? { result: job.result } : {}),
  };
}

/**
 * Background SFTP jobs per owner: at most `limit` running at once, each ended after
 * `jobMs` as `failed` with `SFTP_TIMEOUT`, ended jobs kept for `keepMs`. A job holds
 * its slot (and its lock) until its run has settled, even after a timeout or
 * `closeAll` ended it. A job may name a `lock` `{ hostId, path, write }`: two writing
 * jobs on one host whose remote folders overlap (one inside the other) never run at
 * once (`SFTP_BUSY`); reading jobs run alongside anything. Progress listeners hear a
 * job at most once per second while it runs, and once when it ends.
 */
export class SftpJobs {
  #jobs = new Map();
  #listeners = new Set();
  #now;
  #limit;
  #keepMs;
  #jobMs;

  constructor({
    now = Date.now,
    limit = sftpLimits.runningJobs,
    keepMs = 3600000,
    jobMs = sftpLimits.jobMs,
  } = {}) {
    this.#now = now;
    this.#limit = limit;
    this.#keepMs = keepMs;
    this.#jobMs = jobMs;
  }

  #prune() {
    const now = this.#now();
    for (const [id, job] of this.#jobs)
      if (job.settled && now - job.endedAt > this.#keepMs) this.#jobs.delete(id);
  }

  #emit(job) {
    const snapshot = view(job);
    for (const listener of this.#listeners) {
      try {
        listener(snapshot, job.owner);
      } catch {
        // A failing listener never stops the job or the other listeners.
      }
    }
  }

  #finish(job, outcome) {
    if (job.state !== "running") return;
    const result =
      outcome && STATES.has(outcome.state)
        ? outcome
        : { ...outcome, state: "failed", code: outcome?.code || "SFTP_FAILED" };
    clearTimeout(job.timer);
    job.state = result.state;
    job.result = result;
    job.endedAt = this.#now();
    this.#emit(job);
    for (const resolve of job.waiters) resolve(view(job));
    job.waiters.clear();
  }

  #job(owner, id) {
    this.#prune();
    const job = this.#jobs.get(id);
    if (!job || job.owner !== owner) throw sftpProblem("SFTP_JOB_NOT_FOUND");
    return job;
  }

  #conflicts(lock) {
    if (!lock?.write) return false;
    return [...this.#jobs.values()].some(
      ({ lock: other, settled }) =>
        !settled &&
        other?.write &&
        other.hostId === lock.hostId &&
        (insideRoot(other.path, lock.path) || insideRoot(lock.path, other.path)),
    );
  }

  /**
   * Starts `run(progress, signal)` in the background; `SFTP_BUSY` at the owner's
   * limit or when `lock` overlaps a running writing job.
   */
  start(owner, { kind, summary = null, run, lock = null }) {
    this.#prune();
    const running = [...this.#jobs.values()].filter(
      (job) => job.owner === owner && !job.settled,
    ).length;
    if (running >= this.#limit || this.#conflicts(lock)) throw sftpProblem("SFTP_BUSY");
    const controller = new AbortController();
    const job = {
      jobId: randomUUID(),
      owner,
      kind,
      summary,
      state: "running",
      progress: { files: 0, filesDone: 0, bytes: 0, bytesDone: 0, current: null },
      result: undefined,
      endedAt: null,
      lastEmit: -Infinity,
      waiters: new Set(),
      lock: lock && { hostId: lock.hostId, path: lock.path, write: Boolean(lock.write) },
      settled: false,
      controller,
      timer: null,
    };
    job.timer = setTimeout(() => {
      controller.abort(sftpProblem("SFTP_TIMEOUT"));
      this.#finish(job, { state: "failed", code: "SFTP_TIMEOUT" });
    }, this.#jobMs);
    job.timer.unref?.();
    this.#jobs.set(job.jobId, job);
    const progress = (update = {}) => {
      if (job.state !== "running") return;
      for (const key of progressKeys)
        if (Object.hasOwn(update, key)) job.progress[key] = update[key];
      const now = this.#now();
      if (now - job.lastEmit < PROGRESS_MS) return;
      job.lastEmit = now;
      this.#emit(job);
    };
    // The slot frees before waiters hear the end, so a waiter may start the next job.
    const settle = (outcome) => {
      job.settled = true;
      this.#finish(job, outcome);
    };
    Promise.resolve()
      .then(() => run(progress, controller.signal))
      .then(settle, (error) =>
        settle({
          state: "failed",
          code: isSftpProblem(error) ? error.code : "SFTP_FAILED",
        }),
      );
    return view(job);
  }

  /** The owner's job; `SFTP_JOB_NOT_FOUND` for another owner's or an expired one. */
  get(owner, id) {
    return view(this.#job(owner, id));
  }

  /** Asks the job to stop; it ends `cancelled` once its run has cleaned up. */
  cancel(owner, id) {
    const job = this.#job(owner, id);
    if (job.state === "running") job.controller.abort(sftpProblem("SFTP_CANCELLED"));
    return view(job);
  }

  /** The job once it ends, or as it is after `ms`. */
  wait(owner, id, ms) {
    const job = this.#job(owner, id);
    if (job.state !== "running") return Promise.resolve(view(job));
    return new Promise((resolve) => {
      const done = (snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      };
      const timer = setTimeout(() => {
        job.waiters.delete(done);
        resolve(view(job));
      }, ms);
      job.waiters.add(done);
    });
  }

  /** Subscribes to progress; returns the unsubscribe function. */
  onProgress(callback) {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  /** Stops every running job (on shutdown); they end `cancelled`. */
  closeAll() {
    for (const job of this.#jobs.values()) {
      if (job.state !== "running") continue;
      job.controller.abort(sftpProblem("SFTP_CANCELLED"));
      this.#finish(job, { state: "cancelled", code: "SFTP_CANCELLED" });
    }
  }
}
