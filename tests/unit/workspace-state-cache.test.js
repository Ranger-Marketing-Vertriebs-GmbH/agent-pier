import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CACHED_CHARS,
  WORKSPACE_STATE_KEY,
  clearWorkspaceState,
  readWorkspaceState,
  saveWorkspaceState,
} from "../../web/app/workspace-state-cache.js";

const memoryStore = () => {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
};
const state = { sessions: [{ id: "one", name: "Release notes" }], accounts: [] };

test("the workspace state is kept for one login and one build", () => {
  const store = memoryStore();
  store.setItem("agentpier-auth-change", "1");
  assert.equal(saveWorkspaceState(state, { store, build: "a" }), true);
  assert.deepEqual(readWorkspaceState({ store, build: "a" }), state);
  assert.equal(readWorkspaceState({ store, build: "b" }), null);
  assert.equal(store.getItem(WORKSPACE_STATE_KEY), null, "a stale entry is removed");
  saveWorkspaceState(state, { store, build: "a" });
  store.setItem("agentpier-auth-change", "2");
  assert.equal(readWorkspaceState({ store, build: "a" }), null);
});

test("invalid, oversized and cleared states leave nothing", () => {
  const store = memoryStore();
  assert.equal(saveWorkspaceState({ sessions: "no" }, { store, build: "a" }), false);
  const huge = { sessions: [{ name: "x".repeat(MAX_CACHED_CHARS) }] };
  assert.equal(saveWorkspaceState(huge, { store, build: "a" }), false);
  assert.equal(store.values.size, 0);
  saveWorkspaceState(state, { store, build: "a" });
  clearWorkspaceState({ store });
  assert.equal(readWorkspaceState({ store, build: "a" }), null);
  store.setItem(WORKSPACE_STATE_KEY, "{broken");
  assert.equal(readWorkspaceState({ store, build: "a" }), null);
});
