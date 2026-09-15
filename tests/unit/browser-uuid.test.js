import test from "node:test";
import assert from "node:assert/strict";
import { browserUuid } from "../../web/lib/browser-uuid.js";

test("browser UUID uses native randomUUID with its crypto receiver", () => {
  const source = {
    randomUUID() {
      assert.equal(this, source);
      return "native-id";
    },
  };
  assert.equal(browserUuid(source), "native-id");
});

test("browser UUID uses strong random bytes with UUID v4 version and variant", () => {
  const source = {
    getRandomValues(bytes) {
      bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      return bytes;
    },
  };
  assert.equal(browserUuid(source), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("browser UUID fails when strong browser randomness is unavailable", () => {
  assert.throws(() => browserUuid({}), /cryptographic randomness/i);
});
