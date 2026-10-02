import test from "node:test";
import assert from "node:assert/strict";
import { ToolTextStore } from "../../server/features/chat/tool-text-store.js";

test("store bounds, lru, replace accounting and forgetSession", () => {
  const store = new ToolTextStore({ maxBytes: 100, maxEntryBytes: 40 });
  store.remember("s", "a", "p", "x".repeat(20)); // 40 bytes
  store.remember("s", "b", "p", "x".repeat(20));
  assert.equal(store.bytes, 80);
  store.lookup("s", "a"); // a is now most recent
  store.remember("s", "c", "p", "x".repeat(20)); // evicts b
  assert.equal(store.lookup("s", "b"), null);
  assert.equal(store.lookup("s", "a").text.length, 20);
  store.remember("s", "a", "p", "x".repeat(10)); // replace subtracts old
  assert.equal(store.bytes, 60);
  store.remember("s", "huge", "p", "x".repeat(21)); // 42 > maxEntryBytes
  assert.equal(store.lookup("s", "huge"), null);
  store.remember("other", "a", "p", "y");
  store.forgetSession("s");
  assert.equal(store.lookup("s", "a"), null);
  assert.equal(store.lookup("other", "a").text, "y");
  assert.equal(store.bytes, 2);
});
