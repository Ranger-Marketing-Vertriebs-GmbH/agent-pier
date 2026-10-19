import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConversationFeeds,
  turnActive,
} from "../../server/features/assistants/conversation-feeds.js";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

const row = (id, text = id) => ({ id, role: "assistant", text, timestamp: 1 });
const history = (messages, extra = {}) => ({
  messages,
  requests: [],
  queued: null,
  nextBefore: null,
  stale: false,
  compacting: false,
  ...extra,
});

/** Feeds over an in-memory history per conversation, counting reads. */
function setup(t, options = {}) {
  const state = {
    histories: new Map([
      ["a", history([row("1"), row("2")])],
      ["b", history([row("x")])],
    ]),
    reads: new Map(),
    generation: "g1",
  };
  const value = new ConversationFeeds({
    read: async (id) => {
      state.reads.set(id, (state.reads.get(id) || 0) + 1);
      const found = state.histories.get(id);
      if (!found) throw Object.assign(new Error("gone"), { status: 404 });
      return structuredClone(found);
    },
    scope: (id) => [id, `session:${id}`, state.generation],
    debounceMs: 20,
    recoveryMs: 60000,
    ...options,
  });
  t.after(() => value.close());
  return { feeds: value, state };
}

function listen(feeds, id, cursor) {
  const frames = [];
  const unsubscribe = feeds.subscribe(id, { cursor }, (frame) => frames.push(frame));
  return { frames, unsubscribe, syncs: () => frames.filter((f) => f.type === "sync") };
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

test("two subscribers share one debounced read and get whole rows", async (t) => {
  const { feeds, state } = setup(t);
  const one = listen(feeds, "a");
  const two = listen(feeds, "a");
  await until(() => one.syncs().length && two.syncs().length, "initial syncs");
  assert.equal(state.reads.get("a"), 1);
  const [first] = one.syncs();
  assert.equal(first.data.sync.mode, "full");
  assert.deepEqual(
    first.data.messages.map((m) => m.id),
    ["1", "2"],
  );
  // A burst of invalidations reads once.
  state.histories.set("a", history([row("1"), row("2", "edited"), row("3")]));
  for (let i = 0; i < 5; i++) feeds.invalidate("a");
  await until(() => one.syncs().length === 2 && two.syncs().length === 2, "delta");
  assert.equal(state.reads.get("a"), 2);
  const delta = one.syncs()[1].data;
  assert.equal(delta.sync.mode, "delta");
  assert.equal(delta.sync.base, first.data.sync.cursor);
  assert.deepEqual(
    delta.upserts.map((m) => [m.id, m.text]),
    [
      ["2", "edited"],
      ["3", "3"],
    ],
  );
  assert.deepEqual(delta.removed, []);
  assert.deepEqual(delta.order, ["1", "2", "3"]);
  assert.deepEqual(Object.keys(delta.metadata).sort(), [
    "compacting",
    "nextBefore",
    "queued",
    "requests",
    "stale",
  ]);
  const applied = applyChatSync(first.data, delta);
  assert.deepEqual(
    applied.messages.map((m) => m.text),
    ["1", "edited", "3"],
  );
});

test("a recompute without differences sends nothing", async (t) => {
  const { feeds, state } = setup(t);
  const one = listen(feeds, "a");
  await until(() => one.syncs().length, "initial");
  feeds.invalidate("a");
  await until(() => state.reads.get("a") === 2, "second read");
  await delay(30);
  assert.equal(one.syncs().length, 1);
});

test("removal and reordering arrive as a delta", async (t) => {
  const { feeds, state } = setup(t);
  const one = listen(feeds, "a");
  await until(() => one.syncs().length, "initial");
  state.histories.set("a", history([row("2"), row("4")]));
  feeds.invalidate("a");
  await until(() => one.syncs().length === 2, "delta");
  const delta = one.syncs()[1].data;
  assert.deepEqual(delta.removed, ["1"]);
  assert.deepEqual(
    delta.upserts.map((m) => m.id),
    ["4"],
  );
  assert.deepEqual(delta.order, ["2", "4"]);
});

test("a known cursor resumes with a delta, an unknown one gets everything", async (t) => {
  const sync = new ChatSync({});
  const { feeds, state } = setup(t, { sync });
  const first = listen(feeds, "a");
  await until(() => first.syncs().length, "initial");
  const cursor = first.syncs()[0].data.sync.cursor;
  first.unsubscribe();
  state.histories.set("a", history([row("1"), row("2"), row("3")]));
  const resumed = listen(feeds, "a", cursor);
  await until(() => resumed.syncs().length, "resume");
  const data = resumed.syncs()[0].data;
  assert.equal(data.sync.mode, "delta");
  assert.equal(data.sync.base, cursor);
  assert.deepEqual(
    data.upserts.map((m) => m.id),
    ["3"],
  );
  // A restarted service knows no cursor.
  const fresh = new ConversationFeeds({
    read: async () => history([row("1")]),
    scope: (id) => [id, "session", "g1"],
    debounceMs: 5,
  });
  t.after(() => fresh.close());
  const after = listen(fresh, "a", cursor);
  await until(() => after.syncs().length, "full after restart");
  assert.equal(after.syncs()[0].data.sync.mode, "full");
  assert.deepEqual(
    after.syncs()[0].data.messages.map((m) => m.id),
    ["1"],
  );
});

test("a new runtime generation sends the whole window again", async (t) => {
  const { feeds, state } = setup(t);
  const one = listen(feeds, "a");
  await until(() => one.syncs().length, "initial");
  state.generation = "g2";
  feeds.invalidate("a");
  await until(() => one.syncs().length === 2, "after scope change");
  assert.equal(one.syncs()[1].data.sync.mode, "full");
});

test("a scoped change reads only its feed, a global change reads all", async (t) => {
  const { feeds, state } = setup(t);
  const a = listen(feeds, "a");
  const b = listen(feeds, "b");
  await until(() => a.syncs().length && b.syncs().length, "initial");
  feeds.invalidate("a");
  await until(() => state.reads.get("a") === 2, "a read again");
  await delay(40);
  assert.equal(state.reads.get("b"), 1);
  feeds.invalidateAll();
  await until(() => state.reads.get("a") === 3 && state.reads.get("b") === 2, "all");
  // Conversations nobody watches are never read.
  feeds.invalidate("c");
  assert.equal(state.reads.has("c"), false);
});

test("a failing read reports its error to every subscriber", async (t) => {
  const { feeds } = setup(t);
  const gone = listen(feeds, "missing");
  await until(() => gone.frames.length, "error");
  assert.equal(gone.frames[0].type, "error");
  assert.equal(gone.frames[0].error.status, 404);
});

test("stream frames append per subscriber; a newcomer gets the whole text", async (t) => {
  const { feeds } = setup(t, {
    runs: (id) => (id === "a" ? [["run", "Hel"]] : []),
  });
  const one = listen(feeds, "a");
  const streams = (l) => l.frames.filter((f) => f.type === "stream");
  assert.deepEqual(streams(one), [
    { type: "stream", runId: "run", from: 0, text: "Hel" },
  ]);
  feeds.stream("a", "run", "Hello");
  feeds.stream("a", "run", "Hello");
  assert.deepEqual(streams(one).at(-1), {
    type: "stream",
    runId: "run",
    from: 3,
    text: "lo",
  });
  assert.equal(streams(one).length, 2);
  const two = listen(feeds, "a");
  assert.deepEqual(streams(two), [
    { type: "stream", runId: "run", from: 0, text: "Hello" },
  ]);
  feeds.stream("a", "run", "Hello world");
  assert.deepEqual(streams(one).at(-1), {
    type: "stream",
    runId: "run",
    from: 5,
    text: " world",
  });
  assert.deepEqual(streams(two).at(-1), streams(one).at(-1));
  // A rewrite is no append: everyone gets it whole.
  feeds.stream("a", "run", "Bye");
  assert.deepEqual(streams(one).at(-1), {
    type: "stream",
    runId: "run",
    from: 0,
    text: "Bye",
  });
  // Other conversations never see this run.
  const b = listen(feeds, "b");
  assert.deepEqual(streams(b), []);
  // An ended run is history: a newcomer gets no stream for it.
  feeds.endRun("a", "run");
  const three = listen(feeds, "a");
  assert.deepEqual(streams(three), []);
  // A new connection restarts every run whole.
  feeds.stream("a", "next", "One");
  feeds.clearRuns();
  feeds.stream("a", "next", "One two");
  assert.deepEqual(streams(one).at(-1), {
    type: "stream",
    runId: "next",
    from: 0,
    text: "One two",
  });
});

test("the recovery re-read runs only while a turn is active", async (t) => {
  const { feeds, state } = setup(t, { recoveryMs: 30 });
  const one = listen(feeds, "a");
  await until(() => one.syncs().length, "initial");
  await delay(120);
  assert.equal(state.reads.get("a"), 1);
  state.histories.set(
    "a",
    history([row("1")], { requests: [{ id: "r", attempt: { state: "running" } }] }),
  );
  feeds.invalidate("a");
  await until(() => state.reads.get("a") >= 4, "recovery reads while active");
  assert.equal(turnActive({ compacting: true }), true);
  assert.equal(turnActive({ requests: [{ attempt: { state: "completed" } }] }), false);
});

test("the HTTP read encodes against a cursor; close ends every subscriber", async (t) => {
  const { feeds, state } = setup(t);
  const full = await feeds.snapshot("a", "");
  assert.equal(full.sync.mode, "full");
  state.histories.set("a", history([row("1"), row("2"), row("3")]));
  const delta = await feeds.snapshot("a", full.sync.cursor);
  assert.equal(delta.sync.mode, "delta");
  assert.deepEqual(
    delta.upserts.map((m) => m.id),
    ["3"],
  );
  assert.equal((await feeds.snapshot("a", "not a cursor!")).sync.mode, "full");
  const one = listen(feeds, "a");
  feeds.close();
  assert.deepEqual(one.frames.at(-1), { type: "end" });
  assert.throws(() => feeds.subscribe("a", {}, () => {}));
});
