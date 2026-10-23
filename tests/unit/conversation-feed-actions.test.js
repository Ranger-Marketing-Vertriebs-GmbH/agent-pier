import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationFeeds } from "../../server/features/assistants/conversation-feeds.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

const pendingAction = (id, revision = 1) => ({
  id,
  revision,
  state: "awaiting_approval",
  payload: { action: "memory_write" },
});

/** Feeds whose histories carry each owner's pending actions, counting reads. */
function setup(t) {
  const state = {
    owners: new Map([
      ["a", "agent-1"],
      ["b", "agent-2"],
    ]),
    actions: new Map([
      ["agent-1", []],
      ["agent-2", []],
    ]),
    reads: new Map(),
  };
  const feeds = new ConversationFeeds({
    read: async (id) => {
      state.reads.set(id, (state.reads.get(id) || 0) + 1);
      return {
        messages: [{ id: "1", role: "assistant", text: "hi", timestamp: 1 }],
        requests: [],
        stale: false,
        actions: structuredClone(state.actions.get(state.owners.get(id))),
      };
    },
    scope: (id) => [id, "session", "g1"],
    owner: (id) => {
      if (!state.owners.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
      return state.owners.get(id);
    },
    debounceMs: 10,
    recoveryMs: 60000,
  });
  t.after(() => feeds.close());
  return { feeds, state };
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(5);
  }
}

function listen(feeds, id) {
  const frames = [];
  feeds.subscribe(id, {}, (frame) => frames.push(frame));
  return frames;
}

test("a changed action list goes out as a metadata delta; an unchanged one sends nothing", async (t) => {
  const { feeds, state } = setup(t);
  const frames = listen(feeds, "a");
  await until(() => frames.length === 1, "first window");
  assert.deepEqual(frames[0].data.actions, []);
  state.actions.set("agent-1", [pendingAction("x")]);
  feeds.invalidateOwners(["agent-1"]);
  await until(() => frames.length === 2, "delta with the action");
  const delta = frames[1].data;
  assert.equal(delta.sync.mode, "delta");
  assert.deepEqual(delta.upserts, []);
  assert.deepEqual(delta.metadata.actions, [pendingAction("x")]);
  assert.deepEqual(applyChatSync(frames[0].data, delta).actions, [pendingAction("x")]);
  // The same list again: a read, but no frame.
  const reads = state.reads.get("a");
  feeds.invalidateOwners(["agent-1"]);
  await until(() => state.reads.get("a") === reads + 1, "re-read");
  await delay(30);
  assert.equal(frames.length, 2);
});

test("an owner's invalidation reads only that owner's open chats", async (t) => {
  const { feeds, state } = setup(t);
  const a = listen(feeds, "a");
  const b = listen(feeds, "b");
  await until(() => a.length === 1 && b.length === 1, "first windows");
  feeds.invalidateOwners(["agent-2"]);
  await until(() => state.reads.get("b") === 2, "b reads again");
  await delay(30);
  assert.equal(state.reads.get("a"), 1);
  feeds.invalidateOwners([]);
  await delay(30);
  assert.deepEqual([state.reads.get("a"), state.reads.get("b")], [1, 2]);
  // A chat whose owner cannot be resolved reads again and reports what it finds.
  state.owners.delete("a");
  feeds.invalidateOwners(["agent-9"]);
  await until(() => state.reads.get("a") === 2, "an unresolved chat reads again");
});

test("the action store reports every written row and counts writes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE assistants(id TEXT PRIMARY KEY)");
  db.exec("INSERT INTO assistants VALUES ('agent-1')");
  const store = new AssistantActionStore(db);
  const written = [];
  store.onWrite = (...rows) => written.push(rows.map((r) => r.state ?? null));
  const record = {
    assistantId: "agent-1",
    key: "k",
    payload: { action: "memory_write" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
  };
  const a = store.reserve(record);
  // A retry of the same reservation writes nothing.
  store.reserve(record);
  store.patch(a.id, { state: "declined" });
  store.pruneTrusted("agent-1", "ssh", 5);
  assert.deepEqual(written, [["awaiting_approval"], ["awaiting_approval", "declined"]]);
  assert.equal(store.writes, 2);
});
