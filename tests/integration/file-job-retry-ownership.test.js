import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { failedRetry, retrySettled } from "../helpers/file-retries.js";
import { fileProblem } from "../../server/features/files/file-errors.js";

test("real upload directory child stays with its manifest owner while standalone directory retry remains valid", async (t) => {
  const f = await uploadFixture(t),
    target = path.join(f.home, "owned-directory");
  const stage = f.publisher.stage.bind(f.publisher);
  f.publisher.stage = async (...args) => {
    if (args[1] === target) throw fileProblem("FILE_ACCESS_DENIED", 403);
    return stage(...args);
  };
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, groupId, {
    batchId: "directory",
    entries: [
      { id: "directory", relativePath: "owned-directory", type: "directory", bytes: 0 },
    ],
  });
  await f.uploads.commitGroup(f.scope, groupId);
  await f.until(() => !f.jobs.owns(groupId));
  const before = f.store.getEntry(groupId, "directory"),
    child = f.jobs.get(f.scope, before.currentJobId);
  assert.equal(before.status, "failed");
  await assert.rejects(f.retries.preview(f.scope, child.id), {
    code: "FILE_RETRY_UNAVAILABLE",
  });
  assert.equal(child.uploadGroupId, groupId);
  await assert.rejects(
    f.retries.start(f.scope, child.id, {
      requestId: uploadRequest(),
      reference: `r1:${"a".repeat(64)}`,
    }),
    { code: "FILE_RETRY_UNAVAILABLE" },
  );
  assert.deepEqual(f.store.getEntry(groupId, "directory"), before);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  f.publisher.stage = stage;
  const { job } = await failedRetry(f, "create_directory");
  assert.equal(f.jobs.get(f.scope, job.id).uploadGroupId, undefined);
  const proposal = await f.retries.preview(f.scope, job.id);
  const retry = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await retrySettled(f, retry)).status, "completed");
});
