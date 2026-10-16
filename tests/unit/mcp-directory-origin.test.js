import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  cleanDirectoryOrigin,
  readDirectoryOrigin,
} from "../../server/features/mcp-servers/directory-origin.js";

test("a directory origin is a registry name and an exact version string", () => {
  assert.deepEqual(cleanDirectoryOrigin({ name: "io.github.a/b", version: "0.4.1" }), {
    name: "io.github.a/b",
    version: "0.4.1",
  });
  assert.equal(cleanDirectoryOrigin(undefined), null);
  assert.equal(cleanDirectoryOrigin(null), null);
  for (const bad of [
    { name: "x", version: "1" },
    { name: "a/b", version: "1 2" },
    { name: "a/b", version: "1", extra: true },
    { name: "a/b", version: "x".repeat(129) },
    { name: `${"a".repeat(151)}/b`, version: "1" },
    { name: "a/b" },
    "a/b@1",
    [],
  ])
    assert.throws(
      () => cleanDirectoryOrigin(bad),
      (error) => error.status === 400,
      JSON.stringify(bad),
    );
});

test("stored text is read back or ignored, never thrown", () => {
  assert.deepEqual(readDirectoryOrigin('{"name":"a.b/c","version":"1.0.0"}'), {
    name: "a.b/c",
    version: "1.0.0",
  });
  for (const text of [null, "", "{", '{"name":"<x>","version":"1"}', "[]", "42", "null"])
    assert.equal(readDirectoryOrigin(text), null, String(text));
  fc.assert(
    fc.property(fc.string(), (text) =>
      assert.doesNotThrow(() => readDirectoryOrigin(text)),
    ),
  );
});
