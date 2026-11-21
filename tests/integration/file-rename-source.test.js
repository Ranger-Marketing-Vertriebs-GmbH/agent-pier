import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { trashFixture } from "../helpers/file-trash.js";
import { entryRevision } from "../../server/features/files/file-paths.js";
import { FileMutations } from "../../server/features/files/file-mutations.js";

test("a rename result names its source next to its new path", async (t) => {
  const f = await trashFixture(t);
  const mutations = new FileMutations(f);
  await fs.writeFile(f.target, "original");
  const revision = entryRevision(await fs.lstat(f.target, { bigint: true }));
  await mutations.rename({
    scope: f.globalScope,
    jobId: f.jobId,
    operation: {
      kind: "rename",
      sources: [f.target],
      target: null,
      name: "renamed.txt",
      options: { revisions: { [f.target]: revision } },
    },
    signal: new AbortController().signal,
    report: async () => {},
    conflict: async () => assert.fail("unexpected conflict"),
  });
  const rows = f.publisher.store.db
    .prepare("SELECT document FROM job_entries WHERE job_id=?")
    .all(f.jobId)
    .map((row) => JSON.parse(row.document));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, f.target);
  assert.equal(rows[0].path, path.join(f.home, "renamed.txt"));
});
