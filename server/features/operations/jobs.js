import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { folder, atomic, readJson, identifier } from "./files.js";
import { problem } from "../../lib/storage.js";
export class OperationJobs {
  constructor(dataDir, { onFailure = () => {} } = {}) {
    this.directory = folder(path.join(dataDir, "operations/jobs"));
    this.tasks = new Set();
    this.onFailure = onFailure;
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
          error:
            "The web process restarted before this operation completed. Review its artifacts before retrying.",
        });
    }
  }
  get(id) {
    const file = path.join(this.directory, `${identifier(id)}.json`);
    const value = readJson(file, null);
    if (!value) throw problem("Operation not found.", 404);
    if (
      value.status === "running" &&
      value.external &&
      Date.now() - Date.parse(value.heartbeatAt || value.createdAt) > 30000
    ) {
      value.status = "interrupted";
      value.error =
        "The release helper stopped reporting. Inspect service health and the release pointer before retrying.";
      atomic(file, value);
    }
    const { external: _external, heartbeatAt: _heartbeatAt, ...job } = value;
    return job;
  }
  start(kind, action, { external = false } = {}) {
    if (this.closed) throw problem("Operations are shutting down.", 503);
    const job = {
      id: randomUUID(),
      kind,
      status: "running",
      createdAt: new Date().toISOString(),
      ...(external ? { external: true } : {}),
    };
    const file = path.join(this.directory, `${job.id}.json`);
    atomic(file, job);
    const task = Promise.resolve()
      .then(() => action(job.id))
      .then(
        (result) => {
          if (!external)
            atomic(file, {
              ...job,
              status: "succeeded",
              result,
              finishedAt: new Date().toISOString(),
            });
        },
        (error) => {
          atomic(file, {
            ...job,
            status: "failed",
            ...(typeof error.code === "string" &&
            /^cleanup(?:Invalid|Busy|Changed)$/.test(error.code)
              ? { errorCode: error.code }
              : {}),
            error: error.status
              ? error.message
              : "The operation failed. No unverified result was accepted.",
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
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.tasks]);
  }
}
