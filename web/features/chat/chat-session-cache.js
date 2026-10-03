import { currentBuild } from "../../lib/build-check.js";
import { openChatCacheStore } from "./chat-cache-store.js";
import { isChatSnapshot } from "./chat-sync.js";

const VERSION = 1;
const MAX_ENTRIES = 12;
const MAX_SIZE = 8_000_000;
const MAX_OLDER = 300;
const THROTTLE_MS = 5000;

const memory = new Map();
const pending = new Map();
const tombstones = new Set();
let generation = 0;
let store;
let storeOpened = false;
let chain = Promise.resolve();
let timer = null;
let preloading = null;
let persistRequested = false;
let buildOf = currentBuild;
// Device index `key -> { size, accessedAt }`, filled by the preload read and kept
// current by every device write, so eviction never reads stored values. `null`
// means unknown (no preload yet): eviction then waits, since a failed preload
// leaves the cache memory-only and nothing is put.
let index = null;
// The key set of the last device retain; an unchanged poll does no device work.
let retained = null;
// Device writes stop after a failure; destructive operations always keep trying.
let deviceWritable = true;
const AUTH_KEY = "agentpier-auth-change";
const readAuth = () => {
  try {
    return globalThis.localStorage?.getItem(AUTH_KEY) ?? null;
  } catch {
    return null;
  }
};
let authOf = readAuth;
let stamp = authOf();

export const chatCacheKey = (session) =>
  JSON.stringify([session.id, session.accountId, session.tool, session.createdAt]);

const sessionIdOf = (key) => {
  try {
    const parsed = JSON.parse(key);
    return Array.isArray(parsed) ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
};

function getStore() {
  if (!storeOpened) {
    storeOpened = true;
    try {
      store = openChatCacheStore();
    } catch {
      store = null;
    }
  }
  return store;
}

// Any device failure switches the cache to memory-only writes.
const memoryOnly = () => {
  deviceWritable = false;
};

// Another tab logged out or switched account while this one was frozen.
function authChanged() {
  if (authOf() === stamp) return false;
  void clearChatCache();
  return true;
}

function deleteDatabase() {
  try {
    globalThis.indexedDB?.deleteDatabase?.("agentpier.chat.cache.v1");
  } catch {
    // best effort
  }
}

function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  try {
    Promise.resolve(globalThis.navigator?.storage?.persist?.()).catch(() => {});
  } catch {
    // best effort
  }
}

// Serializes device operations so a clear always follows earlier writes.
function enqueue(task, { destructive = false, fallback } = {}) {
  chain = chain.then(async () => {
    if (!destructive && !deviceWritable) return;
    let current = getStore();
    if (!current && destructive) {
      try {
        current = openChatCacheStore();
      } catch {
        current = null;
      }
    }
    if (!current) return;
    try {
      await task(current);
    } catch {
      memoryOnly();
      index = null;
      fallback?.(current);
    }
  });
  return chain;
}

const meta = (entry) => ({ size: entry.size || 0, accessedAt: entry.accessedAt || 0 });

// Least recently used keys to drop so the device keeps MAX_ENTRIES and MAX_SIZE.
function evictions(puts) {
  const next = new Map(index);
  for (const entry of puts) next.set(entry.key, meta(entry));
  const sorted = [...next].sort((a, b) => a[1].accessedAt - b[1].accessedAt);
  let total = sorted.reduce((sum, [, value]) => sum + value.size, 0);
  let count = next.size;
  const deletes = [];
  for (const [key, value] of sorted) {
    if (count <= MAX_ENTRIES && total <= MAX_SIZE) break;
    deletes.push(key);
    next.delete(key);
    count -= 1;
    total -= value.size;
  }
  return { next, deletes };
}

function forgetIndexed(keys) {
  for (const key of keys) index?.delete(key);
}

function uniqueIds(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (row?.id === undefined) continue;
    if (seen.has(row.id)) return false;
    seen.add(row.id);
  }
  return true;
}

const restorable = (live) =>
  isChatSnapshot(live) && live.availability === "ready" && live.messages.length > 0;

function validEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.version !== VERSION) return false;
  if (typeof entry.key !== "string" || typeof entry.sessionId !== "string") return false;
  const build = buildOf();
  if (entry.build && build && entry.build !== build) return false;
  if (entry.sessionId !== sessionIdOf(entry.key)) return false;
  if (!restorable(entry.live) || !Array.isArray(entry.older)) return false;
  return uniqueIds([...entry.older, ...entry.live.messages]);
}

function remember(entry) {
  memory.delete(entry.key);
  memory.set(entry.key, entry);
  while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
}

export function preloadChatCache() {
  preloading ??= (async () => {
    const current = getStore();
    if (!current || !deviceWritable) return;
    requestPersistence();
    const started = generation;
    let entries;
    // On the device queue, so the index matches exactly what earlier writes left.
    await enqueue(async (device) => {
      const loaded = await device.getAll();
      if (!Array.isArray(loaded)) return;
      const valid = [];
      const stale = [];
      for (const entry of loaded) {
        if (validEntry(entry) && !tombstones.has(entry.sessionId)) valid.push(entry);
        else if (typeof entry?.key === "string") stale.push(entry.key);
      }
      index = new Map(valid.map((entry) => [entry.key, meta(entry)]));
      entries = valid;
      if (stale.length) await device.write({ deletes: stale });
    });
    if (started !== generation || !Array.isArray(entries)) return;
    const valid = entries;
    // Fill free slots only, at the least recent end; never override a live key.
    valid.sort((a, b) => (b.accessedAt || 0) - (a.accessedAt || 0));
    const added = valid
      .filter((entry) => !memory.has(entry.key))
      .slice(0, Math.max(0, MAX_ENTRIES - memory.size))
      .reverse();
    const current_ = [...memory.values()];
    memory.clear();
    for (const entry of [...added, ...current_]) memory.set(entry.key, entry);
  })();
  return preloading;
}

/** Synchronous memory read; refreshes recency. */
export function peekCachedChat(key) {
  if (authChanged()) return null;
  const entry = memory.get(key);
  if (!entry) return null;
  entry.accessedAt = Date.now();
  remember(entry);
  return entry;
}

// The device layer never stores a pagination gap: oversized `older` is dropped.
function deviceEntry(entry) {
  const result =
    entry.older.length > MAX_OLDER
      ? {
          ...entry,
          older: [],
          cursor: entry.live.history?.cursor,
          paged: false,
          scroll: { ...entry.scroll, stick: true },
        }
      : { ...entry };
  result.size = JSON.stringify(result).length;
  return result;
}

const definedOnly = (state) =>
  Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined));

/**
 * Stores `{ live, older, cursor, paged, scroll? }`. With `create: false` only an
 * existing entry is merged and nothing is ever created.
 */
export function writeCachedChat(key, state, { create = true, flush = false } = {}) {
  try {
    if (authChanged()) return;
    const sessionId = sessionIdOf(key);
    if (sessionId === undefined || tombstones.has(sessionId)) return;
    const existing = memory.get(key);
    if (!create && !existing) return;
    const merged = create ? state : { ...existing, ...definedOnly(state) };
    if (!create && state.scroll) merged.scroll = { ...existing.scroll, ...state.scroll };
    if (!restorable(merged.live)) return;
    const now = Date.now();
    const { nativeInput: _removed, ...live } = merged.live;
    const entry = {
      version: VERSION,
      build: buildOf(),
      key,
      sessionId,
      savedAt: now,
      accessedAt: now,
      size: 0,
      live,
      older: Array.isArray(merged.older) ? merged.older : [],
      cursor: merged.cursor,
      paged: Boolean(merged.paged),
      scroll: merged.scroll,
    };
    remember(entry);
    // Per write only the memory entry changes; the device copy (and its size
    // serialization) is built once per flush, off the per-frame path.
    pending.set(key, { generation, entry });
    if (flush) void flushChatCache();
    else schedule();
  } catch {
    // The cache never breaks the chat.
  }
}

function schedule() {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flushChatCache();
  }, THROTTLE_MS);
  timer?.unref?.();
}

export function flushChatCache() {
  if (authChanged()) return chain;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return chain;
  requestPersistence();
  return enqueue(async (current) => {
    // A logout in another tab may land between enqueue and this task.
    if (authOf() !== stamp) {
      void clearChatCache();
      return;
    }
    const puts = batch
      .filter(
        ({ generation: queued, entry }) =>
          queued === generation && !tombstones.has(entry.sessionId),
      )
      .map(({ entry }) => deviceEntry(entry));
    if (puts.length === 0) return;
    const { next, deletes } = index ? evictions(puts) : { next: null, deletes: [] };
    const kept = puts.filter((entry) => !deletes.includes(entry.key));
    // Puts and evictions commit in one transaction.
    await current.write({ puts: kept, deletes });
    if (next) index = next;
    if (retained && kept.some((entry) => !retained.has(entry.key))) retained = null;
  });
}

// Contract: only for real session deletion (ids are unique), so the tombstone stays
// for the page lifetime. retainCachedChats deletes without tombstoning.
export function forgetCachedChat(sessionId) {
  tombstones.add(sessionId);
  for (const key of [...memory.keys()]) {
    if (sessionIdOf(key) === sessionId) memory.delete(key);
  }
  for (const key of [...pending.keys()]) {
    if (sessionIdOf(key) === sessionId) pending.delete(key);
  }
  void enqueue(
    async (current) => {
      const deletes = (await current.getAll())
        .filter(
          (entry) =>
            entry?.sessionId === sessionId || sessionIdOf(entry?.key) === sessionId,
        )
        .map((entry) => entry.key);
      if (deletes.length) await current.write({ deletes });
      forgetIndexed(deletes);
    },
    { destructive: true },
  );
}

const sameKeys = (left, right) =>
  left !== null &&
  left.size === right.size &&
  [...left].sort().join("\n") === [...right].sort().join("\n");

/** Called on every state poll: an unchanged key set does no device work. */
export function retainCachedChats(validKeys) {
  for (const key of [...memory.keys()]) if (!validKeys.has(key)) memory.delete(key);
  for (const key of [...pending.keys()]) if (!validKeys.has(key)) pending.delete(key);
  if (sameKeys(retained, validKeys)) return;
  const keys = new Set(validKeys);
  retained = keys;
  void enqueue(
    async (current) => {
      // Keys only: deciding deletions never reads stored chats.
      const deletes = (await current.getAllKeys()).filter((key) => !keys.has(key));
      if (deletes.length) await current.write({ deletes });
      forgetIndexed(deletes);
    },
    {
      destructive: true,
      fallback: () => {
        retained = null;
      },
    },
  );
}

export function clearChatCache() {
  generation += 1;
  memory.clear();
  pending.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  stamp = authOf();
  retained = null;
  return enqueue(
    async (current) => {
      await current.clear();
      index = new Map();
    },
    {
      destructive: true,
      // The cached handle would block deleteDatabase; close it first.
      fallback: (current) => {
        try {
          current?.close?.();
        } catch {
          // best effort
        }
        deleteDatabase();
      },
    },
  );
}

/** Marks a cached snapshot as not live until the first accepted server frame. */
export function restoredSnapshot(live) {
  const { clientObservedAt: _observed, ...rest } = live;
  return {
    ...rest,
    nativeInput: null,
    observability: { ...live.observability, stale: true },
    restored: true,
  };
}

// Test hook: installs an adapter (null for memory-only) and resets all state.
export function __setChatCacheStore(
  adapter,
  getBuild = currentBuild,
  getAuth = readAuth,
) {
  store = adapter;
  deviceWritable = true;
  authOf = getAuth;
  stamp = authOf();
  storeOpened = true;
  buildOf = getBuild;
  generation += 1;
  memory.clear();
  pending.clear();
  tombstones.clear();
  preloading = null;
  index = null;
  retained = null;
  persistRequested = false;
  chain = Promise.resolve();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

globalThis.document?.addEventListener?.("visibilitychange", () => {
  if (globalThis.document.visibilityState === "hidden") void flushChatCache();
});
