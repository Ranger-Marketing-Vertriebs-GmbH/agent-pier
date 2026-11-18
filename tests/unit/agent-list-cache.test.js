import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_LIST_KEY,
  MAX_CACHED_CHARS,
  clearAgentList,
  hasAgentList,
  readAgentList,
  saveAgentList,
} from "../../web/features/assistants/agent-list-cache.js";
import { featureAfterFailure } from "../../web/features/assistants/agent-offline.js";

function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const list = {
  assistants: [
    { id: "home", name: "Home assistant", model: { modelId: "m" } },
    {
      id: "hers",
      name: "Her agent",
      userAccess: { mode: "own" },
      model: { modelId: "m" },
    },
  ],
  conversations: [
    { id: "dinner", assistantId: "home", title: "Dinner" },
    { id: "private", assistantId: "hers", title: "Her chat" },
  ],
  runtime: { availability: "ready", sync: "current" },
};

test("a kept list comes back for the same login and build, without users' chats", () => {
  const store = memoryStore({ "agentpier-auth-change": "1" });
  assert.equal(saveAgentList(list, { store, build: "b1" }), true);
  const kept = readAgentList({ store, build: "b1" });
  assert.deepEqual(
    kept.list.assistants.map((agent) => agent.id),
    ["home", "hers"],
  );
  assert.deepEqual(
    kept.list.conversations.map((chat) => chat.id),
    ["dinner"],
  );
  assert.deepEqual(kept.list.runtime, list.runtime);
  assert.equal(hasAgentList({ store, build: "b1" }), true);
});

test("another login, build or a corrupt entry finds nothing and drops the entry", () => {
  for (const change of [
    (store) => store.setItem("agentpier-auth-change", "2"),
    () => "b2",
    (store) => store.setItem(AGENT_LIST_KEY, "{not json"),
  ]) {
    const store = memoryStore({ "agentpier-auth-change": "1" });
    saveAgentList(list, { store, build: "b1" });
    const build = change(store) || "b1";
    assert.equal(readAgentList({ store, build }), null);
    assert.equal(store.map.has(AGENT_LIST_KEY), false);
  }
});

test("a list too large to keep, a logout and blocked storage keep nothing", () => {
  const store = memoryStore();
  saveAgentList(list, { store, build: "b" });
  const huge = {
    assistants: [{ id: "a", name: "x".repeat(MAX_CACHED_CHARS) }],
    conversations: [],
  };
  assert.equal(saveAgentList(huge, { store, build: "b" }), false);
  assert.equal(store.map.has(AGENT_LIST_KEY), false);
  saveAgentList(list, { store, build: "b" });
  clearAgentList({ store });
  assert.equal(readAgentList({ store, build: "b" }), null);
  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(saveAgentList(list, { store: blocked, build: "b" }), false);
  assert.equal(readAgentList({ store: blocked, build: "b" }), null);
  assert.equal(saveAgentList(null, { store, build: "b" }), false);
});

test("a first switch read that fails counts agents as on only when this login kept a list", () => {
  const first = { enabled: false, loading: true };
  assert.equal(featureAfterFailure(first, "FAILED", true).enabled, true);
  assert.equal(featureAfterFailure(first, "FAILED", false).enabled, false);
  // A switch read as off stays off, kept list or not.
  assert.equal(
    featureAfterFailure({ enabled: false, loading: false }, "FAILED", true).enabled,
    false,
  );
});
