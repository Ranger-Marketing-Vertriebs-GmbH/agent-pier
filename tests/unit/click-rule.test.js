import test from "node:test";
import assert from "node:assert/strict";
import {
  itemFromRoute,
  itemRoute,
  placeItem,
  singleRoute,
  tabOfMode,
} from "../../web/features/views/click-rule.js";
import { paneLeaf } from "../../web/features/views/split-tree.js";

const s1 = { kind: "session", id: "s1" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };

test("items map to and from their single-view routes", () => {
  assert.equal(itemRoute(c1), "/agents/a1/chats/c1");
  assert.equal(itemRoute(s1), "/sessions/s1");
  assert.deepEqual(singleRoute(s1, "chat"), {
    view: "workspace",
    sessionId: "s1",
    mode: "reader",
  });
  assert.deepEqual(singleRoute(s1, "files"), {
    view: "workspace",
    sessionId: "s1",
    mode: "files",
  });
  assert.deepEqual(singleRoute(c1), {
    view: "agents",
    assistantId: "a1",
    conversationId: "c1",
  });
  assert.equal(
    itemFromRoute({ view: "agents", assistantId: "a1", agentSettings: true }),
    null,
  );
  assert.equal(
    itemFromRoute({
      view: "agents",
      assistantId: "a1",
      conversationId: "c1",
      teamId: "t",
    }),
    null,
  );
  assert.deepEqual(
    itemFromRoute({ view: "agents", assistantId: "a1", conversationId: "c1" }),
    c1,
  );
  assert.deepEqual(
    itemFromRoute({ view: "workspace", sessionId: "s1", mode: "files" }),
    s1,
  );
  assert.equal(itemFromRoute({ view: "workspace", sessionId: "" }), null);
  assert.equal(itemFromRoute({ view: "files" }), null);
});

const view = (id, usedAt, layout) => ({ id, name: id, usedAt, revision: 1, layout });
const views = [
  view("v_a", "2026-11-01T08:00:00Z", paneLeaf(s1)),
  view("v_b", "2026-11-01T09:00:00Z", paneLeaf(s1)),
  view("v_c", "2026-11-01T10:00:00Z", null),
];

test("a placed item is focused in the current view first", () => {
  assert.deepEqual(placeItem({ item: s1, views, currentViewId: "v_a" }), {
    kind: "focus",
    viewId: "v_a",
    key: "session:s1",
  });
});

test("a placed item opens the most recently used other view that holds it", () => {
  assert.deepEqual(placeItem({ item: s1, views, currentViewId: "v_c" }), {
    kind: "switch",
    viewId: "v_b",
    key: "session:s1",
  });
  assert.deepEqual(placeItem({ item: s1, views, currentViewId: null }), {
    kind: "switch",
    viewId: "v_b",
    key: "session:s1",
  });
  const tied = [
    view("v_x", "2026-11-01T09:00:00Z", paneLeaf(c1)),
    view("v_y", "2026-11-01T09:00:00Z", paneLeaf(c1)),
  ];
  assert.deepEqual(placeItem({ item: c1, views: tied, currentViewId: null }), {
    kind: "switch",
    viewId: "v_x",
    key: "chat:a1:c1",
  });
});

test("an item in no view opens its single view", () => {
  assert.deepEqual(
    placeItem({ item: { kind: "session", id: "s9" }, views, currentViewId: null }),
    { kind: "single" },
  );
  assert.deepEqual(placeItem({ item: s1, views: [], currentViewId: "v_a" }), {
    kind: "single",
  });
});

test("a session view mode maps to its pane tab", () => {
  assert.equal(tabOfMode("reader"), "chat");
  assert.equal(tabOfMode("terminal"), "terminal");
  assert.equal(tabOfMode("files"), "files");
  assert.equal(tabOfMode("changes"), "changes");
  assert.equal(tabOfMode(null), undefined);
  assert.equal(tabOfMode("unknown"), undefined);
});
