import { randomUUID } from "node:crypto";
import { isSftpProblem, sftpProblem } from "./sftp-errors.js";
import { sftpLimits } from "./sftp-limits.js";

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
 * `jobMs` as `failed` with `SFTP_TIMEOUT`, ended jobs kept for `keepMs`. Progress
 * listeners hear a job at most once per second while it runs, and once when it ends.
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
      if (job.endedAt !== null && now - job.endedAt > this.#keepMs) this.#jobs.delete(id);
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

  /** Starts `run(progress, signal)` in the background; `SFTP_BUSY` at the limit. */
  start(owner, { kind, summary = null, run }) {
    this.#prune();
    const running = [...this.#jobs.values()].filter(
      (job) => job.owner === owner && job.state === "running",
    ).length;
    if (running >= this.#limit) throw sftpProblem("SFTP_BUSY");
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
    Promise.resolve()
      .then(() => run(progress, controller.signal))
      .then(
        (result) => this.#finish(job, result),
        (error) =>
          this.#finish(job, {
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
