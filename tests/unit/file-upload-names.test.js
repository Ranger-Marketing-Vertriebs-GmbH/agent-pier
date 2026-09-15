import test from "node:test";
import assert from "node:assert/strict";
import {
  uploadNameKey,
  uploadNamePolicy,
} from "../../server/features/files/file-upload-names.js";

test("upload alias keys use pinned canonical decomposition, stable ordering, Hangul and default full folding", () => {
  assert.equal(uploadNamePolicy, "unicode-15.1-cf-nfd-v1");
  for (const [left, right] of [
    ["Straße", "strasse"],
    ["Σςσ", "σσσ"],
    ["İ", "i\u0307"],
    ["ﬃ", "ffi"],
    ["Å", "a\u030a"],
    ["\u212b", "a\u030a"],
    ["\u01fa", "a\u030a\u0301"],
    ["각", "\u1100\u1161\u11a8"],
    ["a\u0301\u0327", "a\u0327\u0301"],
    ["\u0301\u0327a", "\u0327\u0301a"],
  ])
    assert.equal(uploadNameKey(left), right);
  assert.notEqual(uploadNameKey("I"), uploadNameKey("ı"));
  assert.notEqual(uploadNameKey("a\u0300\u0301"), uploadNameKey("a\u0301\u0300"));
  assert.throws(() => uploadNameKey("\ud800"), { code: "FILE_INVALID_NAME" });
});

test("pinned upload keys preserve Unicode15.1 unassigned characters and do not depend on runtime ICU", () => {
  const normalize = String.prototype.normalize;
  String.prototype.normalize = () => {
    throw new Error("runtime normalization must not affect persisted keys");
  };
  try {
    assert.equal(uploadNameKey("\u{105c9}Å"), "\u{105c9}a\u030a");
  } finally {
    String.prototype.normalize = normalize;
  }
});
