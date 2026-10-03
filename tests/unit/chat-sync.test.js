import test from "node:test";
import assert from "node:assert/strict";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import {
  applyChatSync,
  assertChatSnapshot,
  isChatSnapshot,
  chatWindowPrefix,
  prependHistoryRows,
  readOlderPage,
  readRestoredOlderPage,
} from "../../web/features/chat/chat-sync.js";

const row = (id, text = id) => ({ id, role: "assistant", text, images: [] });
function fixture(options = {}) {
  const session = { id: "one", accountId: "account", tool: "codex", createdAt: "now" };
  let snapshot = {
    availability: "ready",
    providerSessionId: "native-one",
    messages: [row("a"), row("b")],
    tasks: [],
    notice: "old notice",
  };
  const sync = new ChatSync({
    sessions: { get: async (id) => ({ ...session, id }) },
    chatImages: { read: async () => structuredClone(snapshot) },
    ...options,
  });
  return {
    sync,
    session,
    get snapshot() {
      return snapshot;
    },
    set: (next) => (snapshot = next),
  };
}

test("unchanged long histories transfer no message bodies and preserve row identity", async () => {
  const f = fixture();
  f.snapshot.messages = Array.from({ length: 500 }, (_, n) =>
    row(String(n), "x".repeat(2000)),
  );
  const first = await f.sync.read("one");
  assert.equal(first.sync.mode, "full");
  const delta = await f.sync.read("one", first.sync.cursor);
  assert.equal(delta.sync.mode, "delta");
  assert.equal(delta.sync.cursor, first.sync.cursor);
  assert.deepEqual(delta.upserts, []);
  assert.equal(delta.order, undefined);
  assert.ok(JSON.stringify(delta).length < JSON.stringify(first).length / 100);
  const merged = applyChatSync(first, delta);
  assert.deepEqual(merged.messages, first.messages);
  assert.equal(merged.messages[0], first.messages[0]);
});

test("deltas atomically apply edits, image changes, deletion, reordering and metadata removal", async () => {
  const f = fixture();
  const first = await f.sync.read("one");
  f.set({
    ...f.snapshot,
    messages: [row("b"), row("c"), { ...row("a", "edited"), images: [{ id: "image" }] }],
  });
  delete f.snapshot.notice;
  f.snapshot.tasks = [{ id: "task", status: "completed" }];
  const delta = await f.sync.read("one", first.sync.cursor);
  assert.deepEqual(
    delta.upserts.map((r) => r.id),
    ["c", "a"],
  );
  const merged = applyChatSync(first, delta);
  assert.deepEqual(merged.messages, f.snapshot.messages);
  assert.equal(merged.messages[0], first.messages[1]);
  assert.equal(merged.notice, undefined);
  assert.deepEqual(merged.tasks, f.snapshot.tasks);
  f.snapshot.messages = [row("c")];
  const removed = await f.sync.read("one", merged.sync.cursor);
  assert.deepEqual(removed.removed, ["b", "a"]);
  assert.deepEqual(applyChatSync(merged, removed).messages, [row("c")]);
  assert.equal(first.messages[0].text, "a");
});

test("unknown, expired, foreign-session, account and binding cursors fall back to full reads", async () => {
  let now = 1;
  const f = fixture({ now: () => now, ttl: 50 });
  const first = await f.sync.read("one");
  for (const cursor of ["missing", [first.sync.cursor], first.sync.cursor + "x"])
    assert.equal((await f.sync.read("one", cursor)).sync.mode, "full");
  assert.equal((await f.sync.read("two", first.sync.cursor)).sync.mode, "full");
  f.session.accountId = "another";
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "full");
  f.session.accountId = "account";
  f.snapshot.providerSessionId = "native-two";
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "full");
  f.snapshot.providerSessionId = "native-one";
  now += 51;
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "full");
  const restarted = fixture();
  assert.equal((await restarted.sync.read("one", first.sync.cursor)).sync.mode, "full");
});

test("baseline storage is globally bounded and contains fingerprints rather than transcripts", async () => {
  const f = fixture({ maxEntries: 2, maxBytes: 2000 });
  const first = await f.sync.read("one");
  for (let n = 0; n < 5; n++) {
    f.snapshot.messages = [row("a", `private body ${n}`)];
    await f.sync.read("one");
  }
  assert.ok(f.sync.cache.size <= 2);
  assert.ok(f.sync.bytes <= 2000);
  assert.ok(!JSON.stringify([...f.sync.cache]).includes("private body"));
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "full");
});

test("invalid baselines and malformed deltas cannot partly overwrite a browser snapshot", async () => {
  const f = fixture();
  const first = await f.sync.read("one");
  f.snapshot.messages.push(row("c"));
  const delta = await f.sync.read("one", first.sync.cursor);
  const invalid = [
    { ...delta, sync: { ...delta.sync, base: "old" } },
    { ...delta, order: ["a", "missing"] },
    { ...delta, order: ["a", "a", "c"] },
    { ...delta, upserts: [row("c"), row("c")] },
    { ...delta, removed: ["unknown"] },
    { ...delta, metadata: { ...delta.metadata, providerSessionId: "another" } },
  ];
  for (const result of invalid) assert.throws(() => applyChatSync(first, result));
  assert.equal(first.messages.length, 2);
  assert.throws(() => applyChatSync(null, delta));
  const legacy = { messages: [row("old")], tasks: [] };
  assert.equal(applyChatSync(first, legacy), legacy);
  f.snapshot.messages = [row("duplicate"), row("duplicate")];
  const duplicate = await f.sync.read("one", first.sync.cursor);
  assert.equal(duplicate.sync.mode, "full");
  assert.equal(duplicate.sync.cursor, null);
});

test("older pages keep order when rows already rolled out of the live window", () => {
  const all = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` }));
  const window = (n) => ({
    messages: all.slice(Math.max(0, n - 50), n),
    history: { cursor: `c${n}` },
  });
  let live = null;
  let older = [];
  for (let n = 100; n <= 180; n++) {
    const next = window(n);
    const prefix = chatWindowPrefix(live, next);
    if (prefix.length) older = [...older, ...prefix];
    live = next;
  }
  const known = new Set(live.messages.map((row) => row.id));
  older = prependHistoryRows(older, all.slice(80, 130), known);
  older = prependHistoryRows(older, all.slice(30, 80), known);
  const shown = [...older.filter((row) => !known.has(row.id)), ...live.messages];
  assert.deepEqual(
    shown.map((row) => row.id),
    all.slice(30, 180).map((row) => row.id),
  );
});

test("an expired history cursor restarts from the live cursor without duplicates", async () => {
  const pages = {
    live: { messages: [{ id: "m3" }, { id: "m4" }], history: { cursor: "p2" } },
    p2: { messages: [{ id: "m1" }, { id: "m2" }], history: { cursor: "p1" } },
    p1: { messages: [{ id: "m0" }], history: { cursor: null } },
  };
  const reads = [];
  const read = async (cursor) => {
    reads.push(cursor);
    if (!pages[cursor]) throw Object.assign(new Error("expired"), { status: 409 });
    return pages[cursor];
  };
  const known = new Set(["m1", "m2", "m3", "m4", "m5"]);
  const page = await readOlderPage({
    cursor: "evicted",
    liveCursor: "live",
    read,
    known,
  });
  assert.deepEqual(reads, ["evicted", "live", "p2", "p1"]);
  assert.deepEqual(page, pages.p1);
  await assert.rejects(
    readOlderPage({
      cursor: "live",
      liveCursor: "live",
      read: async () => {
        throw Object.assign(new Error("gone"), { status: 409 });
      },
      known,
    }),
    { status: 409 },
  );
  await assert.rejects(
    readOlderPage({
      cursor: "x",
      liveCursor: "live",
      read: async () => {
        throw Object.assign(new Error("server"), { status: 500 });
      },
      known,
    }),
    { status: 500 },
  );
});

test("a restored cursor unknown to the server resets to the live window once", async () => {
  const conflict = () => Object.assign(new Error("Conflict"), { status: 409 });
  const pages = {
    live: { messages: [{ id: "m1" }, { id: "m2" }], history: { cursor: null } },
  };
  const reads = [];
  let resets = 0;
  const read = async (cursor) => {
    reads.push(cursor);
    // Cached rows make the restarted read skip ahead into a cursor the server lost.
    if (cursor === "cached" || cursor === "gone") throw conflict();
    if (cursor === "live" && resets === 0)
      return { messages: [{ id: "o1" }], history: { cursor: "gone" } };
    return pages[cursor];
  };
  const page = await readRestoredOlderPage({
    restored: true,
    cursor: "cached",
    liveCursor: "live",
    read,
    known: new Set(["o1", "m3"]),
    reset: () => {
      resets += 1;
      return new Set(["m3"]);
    },
  });
  assert.equal(resets, 1);
  assert.deepEqual(reads, ["cached", "live", "gone", "live"]);
  assert.deepEqual(page, pages.live);
  await assert.rejects(
    readRestoredOlderPage({
      restored: false,
      cursor: "cached",
      liveCursor: "live",
      read: async () => {
        throw conflict();
      },
      known: new Set(),
      reset: () => assert.fail("a live cursor is never reset"),
    }),
    { status: 409 },
  );
  let retried = 0;
  await assert.rejects(
    readRestoredOlderPage({
      restored: true,
      cursor: "cached",
      liveCursor: "live",
      read: async () => {
        throw conflict();
      },
      known: new Set(),
      reset: () => {
        retried += 1;
        return new Set();
      },
    }),
    { status: 409 },
  );
  assert.equal(retried, 1);
});

test("isChatSnapshot accepts only objects with a messages array", () => {
  assert.equal(isChatSnapshot({ messages: [] }), true);
  for (const value of [{}, null, undefined, { messages: "x" }, []])
    assert.equal(isChatSnapshot(value), false);
});

test("assertChatSnapshot throws the localized invalid-snapshot copy", () => {
  assert.doesNotThrow(() => assertChatSnapshot({ messages: [] }));
  assert.throws(() => assertChatSnapshot({}), { message: /\S/ });
});

const MINUTE = 60000;
const change = (f, n) => f.set({ ...f.snapshot, messages: [row("a", `v${n}`)] });

test("default lifetime keeps baselines valid at 29 minutes and expires them at 31", async () => {
  let now = 1;
  const f = fixture({ now: () => now });
  const first = await f.sync.read("one");
  now += 29 * MINUTE;
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "delta");
  now += 31 * MINUTE;
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "full");
});

test("defaults match the cache contract and parking restarts the lifetime", async () => {
  let now = 1;
  const f = fixture({ now: () => now });
  assert.equal(f.sync.maxBytes, 16 * 1024 * 1024);
  assert.equal(f.sync.maxEntries, 512);
  assert.equal(f.sync.ttl, 30 * MINUTE);
  const first = await f.sync.read("one");
  now += 29 * MINUTE;
  f.sync.park(first.sync.cursor);
  now += 29 * MINUTE;
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "delta");
});

test("a parked cursor survives later frames in the same scope and yields a delta", async () => {
  const f = fixture();
  const first = await f.sync.read("one");
  const cursor = first.sync.cursor;
  f.sync.park(cursor);
  for (let n = 0; n < 9; n++) {
    change(f, n);
    await f.sync.read("one");
  }
  const result = await f.sync.read("one", cursor);
  assert.equal(result.sync.mode, "delta");
  assert.equal(result.sync.base, cursor);
});

test("parked cursors are bounded per scope and expire after 30 minutes", async () => {
  let now = 1;
  const f = fixture({ now: () => now });
  const cursors = [];
  for (let n = 0; n < 3; n++) {
    change(f, n);
    const { sync } = await f.sync.read("one");
    cursors.push(sync.cursor);
    f.sync.park(sync.cursor);
  }
  assert.equal(f.sync.parked.size, 2);
  for (let n = 10; n < 20; n++) {
    change(f, n);
    await f.sync.read("one");
  }
  assert.equal((await f.sync.read("one", cursors[0])).sync.mode, "full");
  assert.equal((await f.sync.read("one", cursors[2])).sync.mode, "delta");
  now += 31 * MINUTE;
  assert.equal((await f.sync.read("one", cursors[2])).sync.mode, "full");
  assert.equal(f.sync.parked.size, 0);
});

test("reads normalize nativeInput so cursors match across transports", async () => {
  const f = fixture();
  const first = await f.sync.read("one");
  const second = await f.sync.read("one", first.sync.cursor);
  assert.equal(second.sync.mode, "delta");
  assert.equal(second.sync.cursor, first.sync.cursor);
  assert.deepEqual(second.upserts, []);
  assert.equal(first.nativeInput, null);
});

test("discard removes active and parked entries for every scope of a session", async () => {
  const f = fixture();
  const first = await f.sync.read("one");
  change(f, 1);
  const second = await f.sync.read("one");
  f.sync.park(second.sync.cursor);
  const other = await f.sync.read("two");
  f.sync.discard("one");
  assert.equal((await f.sync.read("one", first.sync.cursor)).sync.mode, "full");
  assert.equal((await f.sync.read("one", second.sync.cursor)).sync.mode, "full");
  assert.equal((await f.sync.read("two", other.sync.cursor)).sync.mode, "delta");
  assert.equal(f.sync.parked.size, 0);
});
