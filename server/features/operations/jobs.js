import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { folder, atomic, readJson, identifier } from "./files.js";
import { problem } from "../../lib/storage.js";
// Every status write after construction calls `onChange(id, job)` (the live
// `job.operation` topic); the constructor's interrupted marks happen before anyone
// can watch. A throwing listener never breaks a job.
export class OperationJobs {
  constructor(dataDir, { onFailure = () => {}, onChange = () => {} } = {}) {
    this.directory = folder(path.join(dataDir, "operations/jobs"));
    this.tasks = new Set();
    this.onFailure = onFailure;
    this.onChange = onChange;
    this.closed = false;
    for (const name of fs
      .readdirSync(this.directory)
      .filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
      const file = path.join(this.directory, name),
        job = readJson(file);
      if (job.status === "running" && !job.external)
        atomic(file, {
          ...job,
          status: "interrupted",
          finishedAt: new Date().toISOString(),
          error: serverMessages.operations.webProcessRestarted,
        });
    }
  }
  get(id) {
    const file = path.join(this.directory, `${identifier(id)}.json`);
    const value = readJson(file, null);
    if (!value) throw problem(serverMessages.operations.jobNotFound, 404);
    if (
      value.status === "running" &&
      value.external &&
      Date.now() - Date.parse(value.heartbeatAt || value.createdAt) > 30000
    ) {
      value.status = "interrupted";
      value.error = serverMessages.operations.releaseHelperSilent;
      this.write(file, value);
    }
    const { external: _external, heartbeatAt: _heartbeatAt, ...job } = value;
    return job;
  }
  start(kind, action, { external = false } = {}) {
    if (this.closed) throw problem(serverMessages.operations.shuttingDown, 503);
    const job = {
      id: randomUUID(),
      kind,
      status: "running",
      createdAt: new Date().toISOString(),
      ...(external ? { external: true } : {}),
    };
    const file = path.join(this.directory, `${job.id}.json`);
    this.write(file, job);
    const task = Promise.resolve()
      .then(() => action(job.id))
      .then(
        (result) => {
          if (!external)
            this.write(file, {
              ...job,
              status: "succeeded",
              result,
              finishedAt: new Date().toISOString(),
            });
        },
        (error) => {
          this.write(file, {
            ...job,
            status: "failed",
            ...(typeof error.code === "string" &&
            /^(?:cleanup|migrate)(?:Invalid|Busy|Changed|Failed|Blocked|Interrupted|Cancelled)$/.test(
              error.code,
            )
              ? { errorCode: error.code }
              : {}),
            ...(error.result && typeof error.result === "object"
              ? { result: error.result }
              : {}),
            error: error.status
              ? error.message
              : serverMessages.operations.failedUnverified,
            finishedAt: new Date().toISOString(),
          });
          try {
            this.onFailure(job);
          } catch {}
        },
      )
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return this.get(job.id);
  }
  /** Writes `job` to `file` and reports the change. */
  write(file, job) {
    atomic(file, job);
    try {
      const { external: _external, heartbeatAt: _heartbeatAt, ...view } = job;
      this.onChange(job.id, view);
    } catch {}
  }
  running(kindPrefix) {
    return fs
      .readdirSync(this.directory)
      .filter((name) => /^[a-f0-9-]+\.json$/.test(name))
      .some((name) => {
        let job;
        try {
          job = this.get(name.slice(0, -".json".length));
        } catch {
          // The job file vanished or became unreadable between listing and reading.
          return false;
        }
        return job.status === "running" && job.kind.startsWith(kindPrefix);
      });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.tasks]);
  }
}
