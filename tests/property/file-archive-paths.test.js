import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { validateZipEntry } from "../../server/features/files/file-archive-paths.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";

test("archive traversal components and separators never pass destination validation", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("safe", "é", "dir"), { maxLength: 8 }),
      fc.constantFrom("../", "/", "C:/", "..\\"),
      (parts, escape) => {
        assert.throws(
          () =>
            validateZipEntry(
              {
                fileName: escape + parts.join("/") + "/file",
                uncompressedSize: 1,
                generalPurposeBitFlag: 0,
                externalFileAttributes: 0,
              },
              { seen: new Map(), limits: readFileLimits() },
            ),
          { code: "FILE_ARCHIVE_PATH_INVALID" },
        );
      },
    ),
  );
});

test("implicit parents are counted once and an explicit file can never replace a parent", () => {
  fc.assert(
    fc.property(
      fc.array(fc.stringMatching(/^[a-z]{1,12}$/), { minLength: 1, maxLength: 10 }),
      (parts) => {
        const seen = new Map(),
          limits = readFileLimits();
        const entry = (fileName) => ({
          fileName,
          uncompressedSize: 0,
          generalPurposeBitFlag: 0,
          externalFileAttributes: 0,
        });
        validateZipEntry(entry(parts.join("/") + "/child"), { seen, limits });
        assert.equal(seen.size, parts.length + 1);
        validateZipEntry(entry(parts.join("/") + "/"), { seen, limits });
        assert.equal(seen.size, parts.length + 1);
        assert.throws(() => validateZipEntry(entry(parts.join("/")), { seen, limits }), {
          code: "FILE_ARCHIVE_PATH_INVALID",
        });
      },
    ),
  );
});

test("path segment and separator variations reject traversal at every depth", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("one", "三", "é"), { maxLength: 15 }),
      fc.constantFrom("..", ".", "", "back\\slash", "nul\0"),
      (parts, invalid) => {
        const fileName = [...parts, invalid, "leaf"].join("/");
        assert.throws(
          () =>
            validateZipEntry(
              {
                fileName,
                uncompressedSize: 0,
                generalPurposeBitFlag: 0,
                externalFileAttributes: 0,
              },
              { seen: new Map(), limits: readFileLimits() },
            ),
          { code: "FILE_ARCHIVE_PATH_INVALID" },
        );
      },
    ),
  );
});
