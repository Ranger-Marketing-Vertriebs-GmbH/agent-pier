import test from "node:test";
import assert from "node:assert/strict";
import {
  detailKey,
  healthKey,
  normaliseSearch,
  searchKey,
  ttl,
  TtlCache,
} from "../../server/features/mcp-directory/cache.js";

test("entries expire after their TTL on the injected clock", () => {
  let now = 0;
  const cache = new TtlCache({ now: () => now });
  cache.set("a", 1, ttl.success);
  now = ttl.success - 1;
  assert.equal(cache.get("a"), 1);
  now = ttl.success;
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.size, 0);
});

test("the least recently used entry leaves first at the limit", () => {
  const cache = new TtlCache({ limit: 2, now: () => 0 });
  cache.set("a", 1, 10);
  cache.set("b", 2, 10);
  cache.get("a");
  cache.set("c", 3, 10);
  assert.deepEqual([cache.get("a"), cache.get("b"), cache.get("c")], [1, undefined, 3]);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("the cache defaults to 200 entries and spec lifetimes", () => {
  const cache = new TtlCache({ now: () => 0 });
  for (let index = 0; index < 250; index += 1) cache.set(`k${index}`, index, 10);
  assert.equal(cache.size, 200);
  assert.equal(cache.get("k49"), undefined);
  assert.equal(cache.get("k50"), 50);
  assert.deepEqual(ttl, { success: 3_600_000, negative: 60_000, health: 300_000 });
});

test("search keys ignore case and spaces; bases never share entries", () => {
  assert.equal(normaliseSearch("  GitHub  "), "github");
  assert.equal(normaliseSearch("x".repeat(150)).length, 100);
  assert.equal(normaliseSearch(undefined), "");
  assert.equal(
    searchKey("https://a.test", " GitHub ", ""),
    searchKey("https://a.test", "github", ""),
  );
  assert.notEqual(
    searchKey("https://a.test", "github", ""),
    searchKey("https://b.test", "github", ""),
  );
  assert.notEqual(
    searchKey("https://a.test", "github", ""),
    searchKey("https://a.test", "github", "c1"),
  );
  assert.notEqual(
    detailKey("https://a.test", "x/y"),
    searchKey("https://a.test", "x/y", ""),
  );
  assert.notEqual(healthKey("https://a.test"), healthKey("https://b.test"));
  assert.notEqual(healthKey("https://a.test"), detailKey("https://a.test", ""));
});
