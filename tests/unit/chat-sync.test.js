import test from "node:test";
import assert from "node:assert/strict";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

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
