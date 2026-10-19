import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  AssistantListFeed,
  listRows,
} from "../../server/features/assistants/assistant-list-feed.js";
import { ChatSync } from "../../server/features/chat/chat-sync.js";
import { applyListSync } from "../../web/features/assistants/agent-list-sync.js";

const agent = (id, extra = {}) => ({ id, name: id, revision: 1, ...extra });
const list = (extra = {}) => ({
  assistants: [agent("a"), agent("b")],
  conversations: [{ id: "c1", assistantId: "a", unread: 0 }],
  teams: [],
  members: [],
  requests: [],
  policies: {},
  teamSettings: { hostMaxConcurrent: 2 },
  models: [{ connectionId: "x", modelId: "m" }],
  activity: { a: { state: "idle" }, b: { state: "idle" } },
  runtime: { availability: "ready", sync: "current" },
  ...extra,
});

/** A feed over an in-memory list, counting reads. */
function setup(t, options = {}) {
  const state = { list: list(), reads: 0, fail: false };
  const feed = new AssistantListFeed({
    read: async () => {
      state.reads++;
      if (state.fail) throw new Error("gone");
      return structuredClone(state.list);
    },
    debounceMs: 20,
    ...options,
  });
  t.after(() => feed.close());
  return { feed, state };
}

function listen(feed, cursor) {
  const frames = [];
  const unsubscribe = feed.subscribe({ cursor }, (frame) => frames.push(frame));
  return { frames, unsubscribe, syncs: () => frames.filter((f) => f.type === "sync") };
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

test("list rows round-trip every section, empty ones included", () => {
  const value = list({ odd: [{ name: "no id" }], count: 3, nothing: null });
  const rows = listRows(value);
  assert.equal(rows.shape.assistants, "array");
  assert.equal(rows.shape.activity, "object");
  assert.equal(rows.shape.odd, "value");
  assert.ok(rows.messages.some((row) => row.id === "assistants/a"));
  const sync = new ChatSync({});
  const applied = applyListSync(null, sync.encodeScoped(["l"], rows));
  assert.deepEqual(applied.list, value);
});

test("a delta carries only the changed rows and keeps unchanged sections", () => {
  const sync = new ChatSync({});
  const first = applyListSync(null, sync.encodeScoped(["l"], listRows(list())));
  const next = list({
    assistants: [agent("a"), agent("b", { revision: 2 }), agent("c")],
    activity: { a: { state: "working" }, b: { state: "idle" } },
  });
  const delta = sync.encodeScoped(["l"], listRows(next), first.state.sync.cursor);
  assert.equal(delta.sync.mode, "delta");
  assert.deepEqual(
    delta.upserts.map((row) => row.id),
    ["assistants/b", "assistants/c", "activity/a"],
  );
  assert.deepEqual(delta.removed, []);
  const applied = applyListSync(first, delta);
  assert.deepEqual(applied.list, next);
  assert.equal(applied.list.teams, first.list.teams);
  assert.equal(applied.list.conversations, first.list.conversations);
  assert.equal(applied.list.models, first.list.models);
  assert.notEqual(applied.list.assistants, first.list.assistants);
  // A removal and a reorder.
  const later = list({ assistants: [agent("c"), agent("a")] });
  const third = sync.encodeScoped(["l"], listRows(later), applied.state.sync.cursor);
  assert.deepEqual(third.removed, ["assistants/b"]);
  assert.deepEqual(applyListSync(applied, third).list, later);
});

test("a delta on another base or a malformed frame is refused", () => {
  const sync = new ChatSync({});
  const first = applyListSync(null, sync.encodeScoped(["l"], listRows(list())));
  const second = sync.encodeScoped(
    ["l"],
    listRows(list({ count: 1 })),
    first.state.sync.cursor,
  );
  const third = sync.encodeScoped(
    ["l"],
    listRows(list({ count: 2 })),
    second.sync.cursor,
  );
  // The client missed `second`: a gap.
  assert.throws(() => applyListSync(first, third), /Invalid/);
  assert.throws(() => applyListSync(null, third), /Invalid/);
  assert.throws(() => applyListSync(null, { messages: [], sync: { mode: "full" } }));
});

test("a whole list after a reconnect keeps the identity of unchanged sections", () => {
  const sync = new ChatSync({});
  const first = applyListSync(null, sync.encodeScoped(["l"], listRows(list())));
  const full = new ChatSync({}).encodeScoped(["l"], listRows(list({ count: 1 })));
  const applied = applyListSync(first, full);
  assert.equal(applied.list.assistants, first.list.assistants);
  assert.equal(applied.list.count, 1);
});

test("two subscribers share one debounced read; a no-op recompute sends nothing", async (t) => {
  const { feed, state } = setup(t);
  const one = listen(feed);
  const two = listen(feed);
  await until(() => one.syncs().length && two.syncs().length, "initial syncs");
  assert.equal(state.reads, 1);
  assert.equal(one.syncs()[0].data.sync.mode, "full");
  // Unchanged: nothing goes out.
  for (let i = 0; i < 5; i++) feed.invalidate();
  await until(() => state.reads === 2, "recompute");
  await delay(40);
  assert.equal(one.syncs().length, 1);
  assert.equal(two.syncs().length, 1);
  // A burst of changes reads once and sends one delta to each.
  state.list.activity.a = { state: "working" };
  for (let i = 0; i < 5; i++) feed.invalidate();
  await until(() => one.syncs().length === 2 && two.syncs().length === 2, "delta");
  assert.equal(state.reads, 3);
  const delta = one.syncs()[1].data;
  assert.equal(delta.sync.mode, "delta");
  assert.deepEqual(
    delta.upserts.map((row) => row.id),
    ["activity/a"],
  );
  let held = applyListSync(null, one.syncs()[0].data);
  held = applyListSync(held, delta);
  assert.deepEqual(held.list, state.list);
});

test("a subscriber resumes from its cursor; an unknown cursor gets the whole list", async (t) => {
  const { feed, state } = setup(t);
  const one = listen(feed);
  await until(() => one.syncs().length, "initial");
  const cursor = one.syncs()[0].data.sync.cursor;
  one.unsubscribe();
  state.list.conversations[0].unread = 2;
  const back = listen(feed, cursor);
  // The settled list answers at once (nothing new), then the read brings the change.
  await until(() => back.syncs().length === 2, "resume");
  const [settled, resumed] = back.syncs().map((frame) => frame.data);
  assert.equal(settled.sync.mode, "delta");
  assert.equal(settled.sync.base, cursor);
  assert.deepEqual(settled.upserts, []);
  assert.equal(resumed.sync.mode, "delta");
  assert.deepEqual(
    resumed.upserts.map((row) => row.id),
    ["conversations/c1"],
  );
  const stranger = listen(feed, "00000000-0000-0000-0000-000000000000");
  const invalid = listen(feed, "not a cursor!");
  await until(() => stranger.syncs().length && invalid.syncs().length, "full");
  assert.equal(stranger.syncs()[0].data.sync.mode, "full");
  assert.equal(invalid.syncs()[0].data.sync.mode, "full");
});

test("a newcomer gets the settled list at once, then the current one", async (t) => {
  const { feed, state } = setup(t, { debounceMs: 200 });
  const one = listen(feed);
  await until(() => one.syncs().length, "initial");
  const two = listen(feed);
  await delay(20);
  assert.equal(two.syncs().length, 1, "answered before the debounced read");
  assert.equal(state.reads, 1);
});

test("a failed read tells every subscriber; no subscribers means no reads", async (t) => {
  const { feed, state } = setup(t);
  feed.invalidate();
  await delay(40);
  assert.equal(state.reads, 0);
  state.fail = true;
  const one = listen(feed);
  await until(() => one.frames.some((f) => f.type === "list-error"), "error");
  state.fail = false;
  feed.invalidate();
  await until(() => one.syncs().length, "recovered");
});
