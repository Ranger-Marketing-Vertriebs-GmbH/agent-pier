import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { trashFixture } from "./file-trash.js";
import { FileJobs } from "../../server/features/files/file-jobs.js";
import { createFileJobHandlers } from "../../server/features/files/file-job-handlers.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";

export async function copyFixture(t, intercept, overrides = {}) {
  const cleanups = [];
  let f;
  t.after(async () => {
    await f?.jobs?.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  f = await trashFixture({ after: (cleanup) => cleanups.push(cleanup) }, intercept);
  const module = await import("../../server/features/files/file-copy.js").catch((e) => {
    if (e.code === "ERR_MODULE_NOT_FOUND") return {};
    throw e;
  });
  assert.equal(typeof module.FileCopies, "function", "copy/move service exists");
  f.limits = readFileLimits(overrides);
  f.store.limits = f.limits;
  f.handlers = createFileJobHandlers();
  f.copies = new module.FileCopies(f);
  module.registerCopyHandlers(f.handlers, f.copies);
  f.jobs = new FileJobs(f);
  f.operation = (sources, target, kind = "copy") => ({
    requestId: `${Date.now()}:${randomUUID()}`,
    kind,
    sources,
    target,
    name: null,
    options: {},
  });
  f.start = (operation) => f.jobs.start(f.globalScope, operation, { publicOnly: true });
  f.wait = async (
    id,
    states = ["completed", "partially_completed", "failed", "cancelled"],
  ) => {
    for (let i = 0; i < 500; i++) {
      const job = f.jobs.get(f.globalScope, id);
      if (states.includes(job.status)) return job;
      await delay(10);
    }
    assert.fail("job did not finish");
  };
  f.resolve = (job, decision, applyToRemaining = false) =>
    f.jobs.resolve(f.globalScope, job.id, {
      conflictId: job.conflict.id,
      decision,
      applyToRemaining,
    });
  return f;
}

export async function submitCopy(f, sources, target, overrides = {}) {
  const context = await (await f.request("/api/files/context")).json();
  const response = await f.request("/api/files/operations", {
    method: "POST",
    headers: { "X-File-Scope": context.scopeId },
    body: {
      requestId: `${Date.now()}:${randomUUID()}`,
      kind: "copy",
      sources,
      target,
      name: null,
      options: {},
      ...overrides,
    },
  });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}
