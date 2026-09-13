import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationJobs } from "../../server/features/operations/jobs.js";
import { problem } from "../../server/lib/storage.js";

async function directory(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ap-jobs-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("running reports jobs by kind prefix and closed flips on close", async (t) => {
  const jobs = new OperationJobs(await directory(t));
  assert.equal(jobs.closed, false);
  let release;
  jobs.start("release-migrate", () => new Promise((resolve) => (release = resolve)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.running("release-"), true);
  assert.equal(jobs.running("release-migrate"), true);
  assert.equal(jobs.running("backup"), false);
  release({ done: true });
  await jobs.close();
  assert.equal(jobs.closed, true);
  assert.equal(jobs.running("release-"), false);
});

test("failed jobs persist migrate error codes and structured results", async (t) => {
  const jobs = new OperationJobs(await directory(t));
  const job = jobs.start("release-migrate", async () => {
    throw Object.assign(problem("Some sessions failed.", 409), {
      code: "migrateFailed",
      result: { failedSessions: [{ id: "s1", error: "boom" }], reloadedSessions: [] },
    });
  });
  const other = jobs.start("release-cleanup", async () => {
    throw Object.assign(problem("nope", 409), { code: "somethingElse", result: "text" });
  });
  await jobs.close();
  const failed = jobs.get(job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "migrateFailed");
  assert.deepEqual(failed.result, {
    failedSessions: [{ id: "s1", error: "boom" }],
    reloadedSessions: [],
  });
  const plain = jobs.get(other.id);
  assert.equal(plain.errorCode, undefined);
  assert.equal(plain.result, undefined);
});
