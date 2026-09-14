import test from "node:test";
import assert from "node:assert/strict";
import {
  metadataBytes,
  planUploadGroup,
  submitUploadGroup,
} from "../../web/features/files/file-upload-group.js";

const limits = {
  jobEntries: 50000,
  uploadBytes: 10 * 1024 ** 3,
  jobBytes: 50 * 1024 ** 3,
};
test("complete UTF-8 manifest envelopes remain strictly below 60 KiB with stable identities", () => {
  const selection = {
    directories: [],
    files: Array.from({ length: 1000 }, (_, index) => ({
      relativePath: `${index}-${"é".repeat(60)}.txt`,
      file: { size: index },
    })),
  };
  const plan = planUploadGroup(selection, "/target", limits);
  assert.ok(plan.batches.length > 2);
  const entries = plan.batches.flatMap((batch) => batch.entries);
  assert.equal(entries.length, selection.files.length);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
  assert.ok(plan.batches.every((batch) => metadataBytes(batch) < 60 * 1024));
  assert.ok(plan.batches.slice(0, -1).every((batch) => metadataBytes(batch) > 59 * 1024));
  assert.throws(
    () =>
      planUploadGroup({ directories: ["é".repeat(40000)], files: [] }, "/target", limits),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
  assert.throws(
    () =>
      planUploadGroup(
        {
          directories: [],
          files: [{ relativePath: "large", file: { size: limits.uploadBytes + 1 } }],
        },
        "/target",
        limits,
      ),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
});

test("mapping uses complete authoritative IDs and immutable declarations rather than remapped paths", async () => {
  const selection = {
    directories: ["root"],
    files: [{ relativePath: "root/a", file: { size: 2 } }],
  };
  const entries = [
    {
      id: "server-dir",
      type: "directory",
      relativePath: "root",
      path: "/target/root (2)",
      bytes: 0,
    },
    {
      id: "server-file",
      type: "file",
      relativePath: "root/a",
      path: "/target/root (2)/a",
      bytes: 2,
    },
  ];
  const plan = planUploadGroup(selection, "/target", limits);
  const jobs = {
    uploadRequest: async (_, suffix, body) =>
      suffix === "/upload-groups"
        ? { groupId: "actual-group", job: { id: "actual-group" } }
        : suffix.endsWith("/entries")
          ? { batchId: body.batchId }
          : {},
    loadUploadGroup: async () => entries,
  };
  const options = {
    scopeId: "scope",
    plan,
    maxEntries: 50000,
    owns: () => true,
    cancelled: () => false,
    onGroup: () => {},
  };
  const result = await submitUploadGroup(jobs, selection, options);
  assert.equal(result.entries[1].id, "server-file");
  entries[0].relativePath = "unrelated";
  await assert.rejects(submitUploadGroup(jobs, selection, options), {
    code: "FILE_INVALID_RESPONSE",
  });
});
