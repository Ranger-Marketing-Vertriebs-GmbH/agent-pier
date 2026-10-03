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

function fakeStore({ failOn, once = false, gate } = {}) {
  const rows = new Map();
  const calls = [];
  const guard = (name) => {
    if (failOn === name) {
      if (once) failOn = undefined;
      throw new Error(`${name} failed`);
    }
  };
  return {
    rows,
    calls,
    async getAll() {
      calls.push("getAll");
      guard("getAll");
      return [...rows.values()].map((row) => structuredClone(row));
    },
    async getAllKeys() {
      calls.push("getAllKeys");
      guard("getAllKeys");
      return [...rows.keys()];
    },
    async write({ puts = [], deletes = [] }) {
      calls.push(["write", puts.length, deletes.length]);
      guard("write");
      if (gate) await gate;
      for (const entry of puts) rows.set(entry.key, structuredClone(entry));
      for (const name of deletes) rows.delete(name);
    },
    async clear() {
      calls.push("clear");
      guard("clear");
      rows.clear();
    },
    close() {
      calls.push("close");
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

test("writes serialize the entry only once per flush, not per frame", async (t) => {
  const stringify = JSON.stringify;
  let serialized = 0;
  t.after(() => {
    JSON.stringify = stringify;
  });
  JSON.stringify = (value, ...rest) => {
    if (value && typeof value === "object" && "live" in value) serialized += 1;
    return stringify(value, ...rest);
  };
  for (let i = 0; i < 50; i += 1)
    writeCachedChat(key("s1"), state({ live: live({ sync: { cursor: `c${i}` } }) }));
  assert.equal(serialized, 0);
  await flushChatCache();
  JSON.stringify = stringify;
  assert.equal(serialized, 1);
  assert.equal(store.rows.get(key("s1")).live.sync.cursor, "c49");
  assert.ok(store.rows.get(key("s1")).size > 0);
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
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  store = fakeStore({ gate });
  __setChatCacheStore(store, () => build);
  writeCachedChat(key("s1"), state());
  const flushed = flushChatCache();
  await new Promise((resolve) => setImmediate(resolve));
  const cleared = clearChatCache();
  release();
  await Promise.all([flushed, cleared]);
  assert.equal(store.rows.size, 0);
});

test("clear and forget still reach the device after a failed put", async () => {
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  store = fakeStore({ failOn: "write", once: true });
  store.rows.set(key("old"), { key: key("old"), sessionId: "old" });
  store.rows.set(key("s2"), { key: key("s2"), sessionId: "s2" });
  __setChatCacheStore(store, () => build);
  writeCachedChat(key("s3"), state());
  await flushChatCache();
  forgetCachedChat("s2");
  await flushChatCache();
  assert.equal(store.rows.has(key("s2")), false);
  await clearChatCache();
  assert.equal(store.rows.size, 0);
});

test("preload fills free slots at the least recent end only", async () => {
  for (let i = 0; i < 12; i += 1) writeCachedChat(key(`d${i}`), state());
  await flushChatCache();
  store.rows.get(key("d0")).accessedAt = 1;
  __setChatCacheStore(store, () => build);
  writeCachedChat(key("fresh"), state());
  const fresh = peekCachedChat(key("fresh"));
  await preloadChatCache();
  assert.equal(peekCachedChat(key("fresh")), fresh);
  assert.equal(peekCachedChat(key("d0")), null);
  writeCachedChat(key("fresh"), { scroll: { offset: 7 } }, { create: false });
  assert.equal(peekCachedChat(key("fresh")).scroll.offset, 7);
});

test("preload rejects mismatched, unrestorable or malformed entries", async () => {
  for (const name of ["id", "empty", "older"]) writeCachedChat(key(name), state());
  await flushChatCache();
  store.rows.get(key("id")).sessionId = "other";
  store.rows.get(key("empty")).live.messages = [];
  store.rows.get(key("older")).older = "x";
  __setChatCacheStore(store, () => build);
  await preloadChatCache();
  for (const name of ["id", "empty", "older"]) {
    assert.equal(peekCachedChat(key(name)), null, name);
  }
});

test("a tab that missed a logout clears instead of flushing or restoring", async () => {
  let auth = "1";
  __setChatCacheStore(
    store,
    () => build,
    () => auth,
  );
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  writeCachedChat(key("s2"), state());
  auth = "2";
  await flushChatCache();
  assert.equal(peekCachedChat(key("s1")), null);
  assert.equal(store.rows.size, 0);
  auth = "3";
  writeCachedChat(key("s3"), state());
  assert.equal(peekCachedChat(key("s3")), null);
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

for (const failOn of ["getAll", "write"]) {
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

test("device eviction drops the least recently accessed in the flush transaction", async () => {
  await preloadChatCache();
  for (let i = 0; i < 12; i += 1) {
    writeCachedChat(key(`s${i}`), state());
    await flushChatCache();
  }
  assert.equal(store.rows.size, 12);
  store.calls.length = 0;
  writeCachedChat(key("s12"), state());
  await flushChatCache();
  assert.equal(store.rows.size, 12);
  assert.equal(store.rows.has(key("s0")), false);
  assert.deepEqual(store.calls, [["write", 1, 1]]);
});

test("a flush with several entries uses one transaction and reads no values", async () => {
  for (let i = 0; i < 10; i += 1) writeCachedChat(key(`old${i}`), state());
  await flushChatCache();
  __setChatCacheStore(store, () => build);
  await preloadChatCache();
  store.calls.length = 0;
  for (let i = 0; i < 5; i += 1) writeCachedChat(key(`new${i}`), state());
  await flushChatCache();
  assert.deepEqual(store.calls, [["write", 5, 3]]);
  assert.equal(store.rows.size, 12);
  for (let i = 0; i < 5; i += 1) assert.ok(store.rows.has(key(`new${i}`)));
});

test("eviction waits while the device index is unknown", async () => {
  for (let i = 0; i < 13; i += 1) writeCachedChat(key(`s${i}`), state());
  await flushChatCache();
  assert.equal(store.rows.size, 13);
  assert.deepEqual(store.calls, [["write", 13, 0]]);
});

test("retain with an unchanged key set does no device work", async () => {
  writeCachedChat(key("s1"), state());
  await flushChatCache();
  retainCachedChats(new Set([key("s1")]));
  await flushChatCache();
  store.calls.length = 0;
  for (let i = 0; i < 3; i += 1) retainCachedChats(new Set([key("s1")]));
  await flushChatCache();
  assert.deepEqual(store.calls, []);
});

test("retain decides deletions from keys only", async () => {
  writeCachedChat(key("s1"), state());
  writeCachedChat(key("s2"), state());
  await flushChatCache();
  store.calls.length = 0;
  retainCachedChats(new Set([key("s1")]));
  await flushChatCache();
  assert.deepEqual(store.calls, ["getAllKeys", ["write", 0, 1]]);
  assert.deepEqual([...store.rows.keys()], [key("s1")]);
});

test("a put of a key outside the retained set re-arms the next retain", async () => {
  retainCachedChats(new Set([key("s1")]));
  writeCachedChat(key("s9"), state());
  await flushChatCache();
  store.calls.length = 0;
  retainCachedChats(new Set([key("s1")]));
  await flushChatCache();
  assert.deepEqual(store.calls, ["getAllKeys", ["write", 0, 1]]);
  assert.equal(store.rows.size, 0);
});

test("a login change after enqueue clears instead of putting", async () => {
  let auth = "1";
  __setChatCacheStore(
    store,
    () => build,
    () => auth,
  );
  writeCachedChat(key("s1"), state());
  const flushed = flushChatCache();
  auth = "2";
  await flushed;
  await flushChatCache();
  assert.ok(!store.calls.some((call) => Array.isArray(call) && call[0] === "write"));
  assert.ok(store.calls.includes("clear"));
  assert.equal(store.rows.size, 0);
  assert.equal(peekCachedChat(key("s1")), null);
});

test("a failed clear closes the cached handle before deleting the database", async (t) => {
  const order = [];
  const original = globalThis.indexedDB;
  t.after(() => {
    globalThis.indexedDB = original;
  });
  globalThis.indexedDB = {
    deleteDatabase: (name) => order.push(["deleteDatabase", name]),
  };
  store = fakeStore({ failOn: "clear" });
  const close = store.close;
  store.close = () => {
    close();
    order.push("close");
  };
  __setChatCacheStore(store, () => build);
  await clearChatCache();
  assert.deepEqual(order, ["close", ["deleteDatabase", "agentpier.chat.cache.v1"]]);
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
