import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { OperationJobs } from "../../server/features/operations/jobs.js";
test("operation jobs survive restart with explicit interrupted or externally owned state", async (t) => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-jobs-")),
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const first = new OperationJobs(dataDir);
  const finished = first.start("backup", async () => ({ backup: { id: "result" } }));
  await first.close();
  const pending = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const file = path.join(dataDir, `operations/jobs/${pending}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      id: pending,
      kind: "backup",
      status: "running",
      createdAt: "2026-09-07T00:00:00Z",
    }),
  );
  const second = new OperationJobs(dataDir);
  assert.equal(second.get(finished.id).status, "succeeded");
  assert.equal(second.get(pending).status, "interrupted");
  const external = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  await fs.writeFile(
    path.join(dataDir, `operations/jobs/${external}.json`),
    JSON.stringify({
      id: external,
      external: true,
      kind: "release-activate",
      status: "running",
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  assert.equal(second.get(external).status, "interrupted");
  await second.close();
});

test("every status write of a job calls onChange with its id and the job", async (t) => {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-jobs-")),
  );
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const changes = [];
  const jobs = new OperationJobs(dataDir, {
    onChange: (id, job) => changes.push([id, job.kind, job.status]),
  });
  const done = jobs.start("backup", async () => ({}));
  const broken = jobs.start("restore", async () => {
    throw new Error("x");
  });
  await jobs.close();
  assert.deepEqual(changes, [
    [done.id, "backup", "running"],
    [broken.id, "restore", "running"],
    [done.id, "backup", "succeeded"],
    [broken.id, "restore", "failed"],
  ]);
  // A silent external job marked interrupted on read is a status write too.
  const external = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  await fs.writeFile(
    path.join(dataDir, `operations/jobs/${external}.json`),
    JSON.stringify({
      id: external,
      external: true,
      kind: "release-activate",
      status: "running",
      createdAt: "2026-01-01T00:00:00Z",
    }),
  );
  changes.length = 0;
  jobs.get(external);
  jobs.get(external);
  assert.deepEqual(changes, [[external, "release-activate", "interrupted"]]);
  // A listener that throws never breaks the job.
  const throwing = new OperationJobs(dataDir, {
    onChange: () => {
      throw new Error("listener");
    },
  });
  const job = throwing.start("backup", async () => ({}));
  await throwing.close();
  assert.equal(throwing.get(job.id).status, "succeeded");
});
