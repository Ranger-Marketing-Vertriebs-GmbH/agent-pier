import test from "node:test";
import assert from "node:assert/strict";
import {
  archivePath,
  archiveOutputLimit,
  validateZipEntry,
} from "../../server/features/files/file-archive-paths.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";

test("archive paths allow the exact depth and UTF-8 byte limits but reject overflow", () => {
  assert.equal(archivePath("a/b", { maxDepth: 2 }), "a/b");
  assert.throws(() => archivePath("a/b/c", { maxDepth: 2 }), {
    code: "FILE_LIMIT_EXCEEDED",
  });
  const segment = "é".repeat(127) + "a";
  const atLimit = Array(256).fill(segment).join("/");
  assert.equal(Buffer.byteLength(atLimit), 65535);
  assert.equal(archivePath(atLimit, { maxDepth: 257 }), atLimit);
  assert.throws(() => archivePath(atLimit + "/a", { maxDepth: 257 }), {
    code: "FILE_INVALID_PATH",
  });
});

test("archive output bounds allow empty content and reject invalid payload sizes", () => {
  assert.equal(archiveOutputLimit(0, []), 256);
  assert.equal(archiveOutputLimit(3, ["é"]), 522);
  for (const payload of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => archiveOutputLimit(payload, []), {
      code: "FILE_LIMIT_EXCEEDED",
    });
});

const entry = (overrides = {}) => ({
  fileName: "entry.txt",
  uncompressedSize: 0,
  generalPurposeBitFlag: 0,
  externalFileAttributes: 0,
  compressionMethod: 8,
  ...overrides,
});

test("ZIP entry size independently respects upload and job limits including exact bounds", () => {
  for (const overrides of [
    { uploadBytes: 5, jobBytes: 10 },
    { uploadBytes: 10, jobBytes: 5 },
  ]) {
    const options = { seen: new Map(), limits: readFileLimits(overrides) };
    assert.deepEqual(validateZipEntry(entry({ uncompressedSize: 5 }), options), {
      relative: "entry.txt",
      type: "file",
      size: 5,
    });
    for (const size of [6, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => validateZipEntry(entry({ uncompressedSize: size }), options), {
        code: "FILE_LIMIT_EXCEEDED",
      });
  }
  assert.throws(
    () =>
      validateZipEntry(entry({ fileName: "directory/", uncompressedSize: 1 }), {
        seen: new Map(),
        limits: readFileLimits(),
      }),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
});

test("ZIP entries reject encrypted data, symlinks, mismatched directory flags and unknown compression", () => {
  for (const overrides of [
    { generalPurposeBitFlag: 1 },
    { externalFileAttributes: 0xa000 << 16 },
    { externalFileAttributes: 0x10 },
    { compressionMethod: 99 },
  ])
    assert.throws(
      () =>
        validateZipEntry(entry(overrides), {
          seen: new Map(),
          limits: readFileLimits(),
        }),
      { code: "FILE_ARCHIVE_INVALID" },
    );
});

test("ZIP implicit parents consume entry capacity and duplicate explicit entries are rejected", () => {
  const options = { seen: new Map(), limits: readFileLimits({ jobEntries: 2 }) };
  assert.deepEqual(validateZipEntry(entry({ fileName: "parent/child" }), options), {
    relative: "parent/child",
    type: "file",
    size: 0,
  });
  assert.throws(() => validateZipEntry(entry({ fileName: "other" }), options), {
    code: "FILE_LIMIT_EXCEEDED",
  });
  assert.throws(() => validateZipEntry(entry({ fileName: "parent/child" }), options), {
    code: "FILE_ARCHIVE_PATH_INVALID",
  });
  assert.deepEqual(validateZipEntry(entry({ fileName: "parent/" }), options), {
    relative: "parent",
    type: "directory",
    size: 0,
  });
  assert.throws(() => validateZipEntry(entry({ fileName: "parent/" }), options), {
    code: "FILE_ARCHIVE_PATH_INVALID",
  });
});
