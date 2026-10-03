import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  __setChatCacheStore,
  chatCacheKey,
  clearChatCache,
  flushChatCache,
  forgetCachedChat,
  peekCachedChat,
  preloadChatCache,
  restoredSnapshot,
  retainCachedChats,
  writeCachedChat,
} from "../../web/features/chat/chat-session-cache.js";

function fakeStore({ failOn } = {}) {
  const rows = new Map();
  const calls = [];
  const guard = (name) => {
    if (failOn === name) throw new Error(`${name} failed`);
  };
  return {
    rows,
    calls,
    async getAll() {
      guard("getAll");
      return [...rows.values()].map((row) => structuredClone(row));
    },
    async put(entry) {
      guard("put");
      calls.push("put");
      rows.set(entry.key, structuredClone(entry));
    },
    async delete(key) {
      guard("delete");
      rows.delete(key);
    },
    async clear() {
      guard("clear");
      rows.clear();
    },
    async evict({ maxEntries, maxSize }) {
      calls.push(["evict", maxEntries, maxSize]);
      const sorted = [...rows.values()].sort((a, b) => a.accessedAt - b.accessedAt);
      let total = sorted.reduce((sum, row) => sum + row.size, 0);
      let count = sorted.length;
      for (const row of sorted) {
        if (count <= maxEntries && total <= maxSize) break;
        rows.delete(row.key);
        count -= 1;
        total -= row.size;
      }
    },
  };
}

const key = (id) =>
  chatCacheKey({ id, accountId: "a", tool: "claude", createdAt: "2026-01-01" });
const rowsOf = (count, prefix = "m") =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
const live = (overrides = {}) => ({
  availability: "ready",
  messages: rowsOf(2),
  history: { cursor: "hist-1" },
  sync: { cursor: "c1" },
  nativeInput: { pending: true },
  observability: { stale: false },
  clientObservedAt: 5,
  ...overrides,
});
const state = (overrides = {}) => ({
  live: live(),
  older: [],
  cursor: "c-page",
  paged: true,
  scroll: { anchorId: "m1", offset: 4, stick: false },
  ...overrides,
});

let store;
let build;
beforeEach(() => {
  store = fakeStore();
  build = "b1";
  __setChatCacheStore(store, () => build);
});

test("memory LRU holds at most 12 entries", () => {
  for (let i = 0; i < 12; i += 1) writeCachedChat(key(`s${i}`), state());
  peekCachedChat(key("s0"));
  writeCachedChat(key("s12"), state());
  assert.equal(peekCachedChat(key("s0")) !== null, true);
  assert.equal(peekCachedChat(key("s1")), null);
  assert.equal(peekCachedChat(key("s12")) !== null, true);
});

test("unrestorable snapshots are not stored", async () => {
  writeCachedChat(key("a"), state({ live: live({ availability: "missing" }) }));
  writeCachedChat(key("b"), state({ live: live({ messages: [] }) }));
  await flushChatCache();
  assert.equal(peekCachedChat(key("a")), null);
  assert.equal(peekCachedChat(key("b")), null);
  assert.equal(store.rows.size, 0);
});

test("older overflow resets the device layer only", async () => {
  const older = rowsOf(301, "o");
  writeCachedChat(key("s1"), state({ older }));
  await flushChatCache();
  const stored = store.rows.get(key("s1"));
  assert.deepEqual(stored.older, []);
  assert.equal(stored.cursor, "hist-1");
  assert.equal(stored.paged, false);
  assert.equal(stored.scroll.stick, true);
  const mem = peekCachedChat(key("s1"));
  assert.equal(mem.older.length, 301);
  assert.equal(mem.paged, true);
});

test("older within the bound is stored as is", async () => {
  writeCachedChat(key("s1"), state({ older: rowsOf(300, "o") }));
  await flushChatCache();
  const stored = store.rows.get(key("s1"));
  assert.equal(stored.older.length, 300);
  assert.equal(stored.cursor, "c-page");
  assert.equal(stored.paged, true);
});

test("nativeInput is never stored", async () => {
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  assert.equal("nativeInput" in store.rows.get(key("s1")).live, false);
  assert.equal(store.rows.get(key("s1")).version, 1);
  assert.equal(store.rows.get(key("s1")).build, "b1");
});

test("preload drops invalid entries", async () => {
  writeCachedChat(key("good"), state());
  writeCachedChat(key("ver"), state());
  writeCachedChat(key("bld"), state());
  writeCachedChat(key("bad"), state());
  writeCachedChat(key("dup"), state());
  await flushChatCache();
  store.rows.get(key("ver")).version = 2;
  store.rows.get(key("bld")).build = "other";
  store.rows.get(key("bad")).live = { messages: "x" };
  store.rows.get(key("dup")).live.messages = [{ id: "x" }, { id: "x" }];
  __setChatCacheStore(store, () => build);
  await preloadChatCache();
  assert.notEqual(peekCachedChat(key("good")), null);
  for (const name of ["ver", "bld", "bad", "dup"]) {
    assert.equal(peekCachedChat(key(name)), null, name);
  }
  await flushChatCache();
  assert.deepEqual([...store.rows.keys()], [key("good")]);
});

test("a clear right after a write leaves nothing behind", async () => {
  writeCachedChat(key("s1"), state());
  await clearChatCache();
  await flushChatCache();
  assert.equal(peekCachedChat(key("s1")), null);
  assert.equal(store.rows.size, 0);
});

test("a clear discards a write that is already in flight", async () => {
  writeCachedChat(key("s1"), state());
  void flushChatCache();
  await clearChatCache();
  assert.equal(store.rows.size, 0);
});

test("a tombstone blocks later writes for a forgotten session", async () => {
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  forgetCachedChat("s1");
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  assert.equal(peekCachedChat(key("s1")), null);
  assert.equal(store.rows.size, 0);
});

test("update-only writes never create and merge scroll", async () => {
  writeCachedChat(key("s1"), state(), { create: false });
  await flushChatCache();
  assert.equal(peekCachedChat(key("s1")), null);
  assert.equal(store.rows.size, 0);
  writeCachedChat(key("s1"), state());
  writeCachedChat(key("s1"), { scroll: { offset: 99 } }, { create: false });
  await flushChatCache();
  const stored = store.rows.get(key("s1"));
  assert.equal(stored.scroll.offset, 99);
  assert.equal(stored.scroll.anchorId, "m1");
  assert.equal(stored.live.messages.length, 2);
});

test("retain removes other keys from memory and device", async () => {
  writeCachedChat(key("s1"), state());
  writeCachedChat(key("s2"), state());
  await flushChatCache();
  retainCachedChats(new Set([key("s1")]));
  await flushChatCache();
  assert.notEqual(peekCachedChat(key("s1")), null);
  assert.equal(peekCachedChat(key("s2")), null);
  assert.deepEqual([...store.rows.keys()], [key("s1")]);
});

for (const failOn of ["getAll", "put"]) {
  test(`a store failing on ${failOn} leaves memory-only operation`, async () => {
    __setChatCacheStore(fakeStore({ failOn }), () => build);
    await preloadChatCache();
    writeCachedChat(key("s1"), state());
    await flushChatCache();
    assert.notEqual(peekCachedChat(key("s1")), null);
    await clearChatCache();
    assert.equal(peekCachedChat(key("s1")), null);
  });
}

test("no adapter means memory-only", async () => {
  __setChatCacheStore(null, () => build);
  await preloadChatCache();
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  assert.notEqual(peekCachedChat(key("s1")), null);
});

test("device eviction runs after puts and drops the least recently accessed", async () => {
  for (let i = 0; i < 13; i += 1) {
    writeCachedChat(key(`s${i}`), state());
    await flushChatCache();
    store.rows.get(key(`s${i}`)).accessedAt = i;
  }
  assert.deepEqual(store.calls.at(-1), ["evict", 12, 8000000]);
  writeCachedChat(key("s13"), state());
  await flushChatCache();
  assert.equal(store.rows.size, 12);
  assert.equal(store.rows.has(key("s0")), false);
});

test("restoredSnapshot marks a snapshot as not live", () => {
  const restored = restoredSnapshot(live());
  assert.equal(restored.nativeInput, null);
  assert.equal(restored.observability.stale, true);
  assert.equal("clientObservedAt" in restored, false);
  assert.equal(restored.restored, true);
  assert.equal(restored.messages.length, 2);
});

test("chatCacheKey is a stable JSON tuple", () => {
  assert.equal(
    chatCacheKey({ id: "s", accountId: "a", tool: "t", createdAt: "c" }),
    '["s","a","t","c"]',
  );
});
