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

// Any device failure switches the cache to memory-only operation.
const memoryOnly = () => {
  store = null;
};

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
function enqueue(task) {
  chain = chain.then(async () => {
    const current = getStore();
    if (!current) return;
    try {
      await task(current);
    } catch {
      memoryOnly();
    }
  });
  return chain;
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
  if (!isChatSnapshot(entry.live)) return false;
  const older = Array.isArray(entry.older) ? entry.older : [];
  return uniqueIds([...older, ...entry.live.messages]);
}

function remember(entry) {
  memory.delete(entry.key);
  memory.set(entry.key, entry);
  while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
}

export function preloadChatCache() {
  preloading ??= (async () => {
    const current = getStore();
    if (!current) return;
    requestPersistence();
    const started = generation;
    let entries;
    try {
      entries = await current.getAll();
    } catch {
      memoryOnly();
      return;
    }
    if (started !== generation || !Array.isArray(entries)) return;
    const valid = [];
    for (const entry of entries) {
      if (validEntry(entry) && !tombstones.has(entry.sessionId)) valid.push(entry);
      else if (typeof entry?.key === "string") void enqueue((s) => s.delete(entry.key));
    }
    valid.sort((a, b) => (a.accessedAt || 0) - (b.accessedAt || 0));
    for (const entry of valid.slice(-MAX_ENTRIES)) {
      if (!memory.has(entry.key)) remember(entry);
    }
  })();
  return preloading;
}

/** Synchronous memory read; refreshes recency. */
export function peekCachedChat(key) {
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
    pending.set(key, { generation, entry: deviceEntry(entry) });
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
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return chain;
  requestPersistence();
  return enqueue(async (current) => {
    let wrote = false;
    for (const { generation: queued, entry } of batch) {
      if (queued !== generation || tombstones.has(entry.sessionId)) continue;
      await current.put(entry);
      wrote = true;
    }
    if (wrote) await current.evict({ maxEntries: MAX_ENTRIES, maxSize: MAX_SIZE });
  });
}

export function forgetCachedChat(sessionId) {
  tombstones.add(sessionId);
  for (const key of [...memory.keys()]) {
    if (sessionIdOf(key) === sessionId) memory.delete(key);
  }
  for (const key of [...pending.keys()]) {
    if (sessionIdOf(key) === sessionId) pending.delete(key);
  }
  void enqueue(async (current) => {
    for (const entry of await current.getAll()) {
      if (entry?.sessionId === sessionId || sessionIdOf(entry?.key) === sessionId) {
        await current.delete(entry.key);
      }
    }
  });
}

export function retainCachedChats(validKeys) {
  for (const key of [...memory.keys()]) if (!validKeys.has(key)) memory.delete(key);
  for (const key of [...pending.keys()]) if (!validKeys.has(key)) pending.delete(key);
  void enqueue(async (current) => {
    for (const entry of await current.getAll()) {
      if (!validKeys.has(entry?.key)) await current.delete(entry.key);
    }
  });
}

export function clearChatCache() {
  generation += 1;
  memory.clear();
  pending.clear();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  return enqueue((current) => current.clear());
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
export function __setChatCacheStore(adapter, getBuild = currentBuild) {
  store = adapter;
  storeOpened = true;
  buildOf = getBuild;
  generation += 1;
  memory.clear();
  pending.clear();
  tombstones.clear();
  preloading = null;
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
