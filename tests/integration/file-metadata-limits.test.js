import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedNativeBytes,
  readAttributes,
} from "../../server/features/files/file-native-attributes.js";

test("metadata bounds reject excess names and aggregate values before reading their contents", () => {
  let values = 0;
  const names = Buffer.from(
    Array.from({ length: 257 }, (_, i) => `user.${i}\0`).join(""),
  );
  assert.throws(
    () =>
      readAttributes(
        {
          list: (_fd, b) => {
            if (b) names.copy(b);
            return names.length;
          },
          get: () => {
            values++;
            return 0;
          },
        },
        1,
      ),
    { code: "FILE_METADATA_LIMIT" },
  );
  assert.equal(values, 0);
  const two = Buffer.from("user.a\0user.b\0");
  let probes = 0;
  assert.throws(
    () =>
      readAttributes(
        {
          list: (_fd, b) => {
            if (b) two.copy(b);
            return two.length;
          },
          get: (_fd, _name, b) => {
            probes++;
            if (!b) return 5 * 1024 * 1024;
            values++;
            return b.length;
          },
        },
        1,
      ),
    { code: "FILE_METADATA_LIMIT" },
  );
  assert.equal(values, 1);
  assert.equal(probes, 3);
  assert.throws(() => boundedNativeBytes(() => 65537, 65536), {
    code: "FILE_METADATA_LIMIT",
  });
});

test("growing native values retry at most twice, preserve errno failures and reject invalid native lengths", () => {
  let probes = 0,
    reads = 0;
  assert.throws(
    () =>
      boundedNativeBytes((buffer) => {
        if (!buffer) {
          probes++;
          return 4;
        }
        reads++;
        throw Object.assign(new Error("growth"), { code: "ERANGE" });
      }, 100),
    { code: "FILE_METADATA_LIMIT" },
  );
  assert.equal(probes, 3);
  assert.equal(reads, 3);
  const denied = Object.assign(new Error("fixture"), { code: "EPERM" });
  assert.throws(
    () =>
      boundedNativeBytes(() => {
        throw denied;
      }, 100),
    (error) => error === denied,
  );
  for (const size of [-1, Infinity, 1.2, 101])
    assert.throws(() => boundedNativeBytes(() => size, 100), {
      code: "FILE_METADATA_LIMIT",
    });
});

test("native metadata rejects malformed UTF-8 attribute names instead of copying a different name", () => {
  const names = Buffer.from([0xff, 0]);
  assert.throws(
    () =>
      readAttributes(
        {
          list: (_fd, b) => {
            if (b) names.copy(b);
            return 2;
          },
          get: () => 0,
        },
        1,
      ),
    { code: "FILE_METADATA_LIMIT" },
  );
});

test("metadata growth from an initially empty result retries with bounded storage", () => {
  let calls = 0;
  const result = boundedNativeBytes((buffer) => {
    calls++;
    if (calls === 1) return 0;
    if (calls === 2) return 4;
    if (!buffer) return 4;
    Buffer.from("data").copy(buffer);
    return 4;
  }, 10);
  assert.equal(result.toString(), "data");
  assert.equal(calls, 4);
});
