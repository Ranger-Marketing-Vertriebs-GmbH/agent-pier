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
