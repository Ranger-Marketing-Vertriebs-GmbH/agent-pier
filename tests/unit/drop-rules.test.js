import test from "node:test";
import assert from "node:assert/strict";
import {
  dropResult,
  hoverItemOf,
  itemForPayload,
  withRememberedTab,
} from "../../web/features/views/drop-rules.js";
import { SessionViewMemory } from "../../web/app/session-view-memory.js";

const pane = (id) => ({ type: "pane", item: { kind: "session", id }, tab: "terminal" });
const split = (dir, a, b, ratio = 0.5) => ({ type: "split", dir, ratio, a, b });
const item = (id) => ({ kind: "session", id });
const big = { width: 2000, height: 2000 };
const two = split("row", pane("s1"), pane("s2"));

test("an edge drop splits and a centre drop replaces", () => {
  const base = { layout: two, viewId: "v1", stageSize: big };
  assert.deepEqual(
    dropResult({
      ...base,
      payload: { item: item("s3") },
      item: item("s3"),
      key: "session:s2",
      side: "bottom",
    }),
    split("row", pane("s1"), split("col", pane("s2"), pane("s3"))),
  );
  assert.deepEqual(
    dropResult({
      ...base,
      payload: { item: item("s3") },
      item: item("s3"),
      key: "session:s2",
      side: "center",
    }),
    split("row", pane("s1"), pane("s3")),
  );
});

test("an edge drop that would not fit the stage is refused, the centre still replaces", () => {
  const small = { width: 600, height: 400 };
  const base = {
    layout: two,
    viewId: "v1",
    stageSize: small,
    payload: { item: item("s3") },
    item: item("s3"),
    key: "session:s2",
  };
  assert.equal(dropResult({ ...base, side: "right" }), two);
  assert.equal(dropResult({ ...base, side: "bottom" }), two);
  assert.deepEqual(
    dropResult({ ...base, side: "center" }),
    split("row", pane("s1"), pane("s3")),
  );
});

test("an edge drop past six panes is refused", () => {
  const six = split(
    "row",
    split("col", pane("s1"), pane("s2")),
    split(
      "row",
      split("col", pane("s3"), pane("s4")),
      split("col", pane("s5"), pane("s6")),
    ),
  );
  const base = {
    layout: six,
    viewId: "v1",
    stageSize: big,
    payload: { item: item("s7") },
    item: item("s7"),
    key: "session:s1",
  };
  assert.equal(dropResult({ ...base, side: "right" }), six);
  assert.notEqual(dropResult({ ...base, side: "center" }), six);
});

test("a pane from another view is refused; one of this view moves", () => {
  const base = {
    layout: two,
    stageSize: big,
    item: null,
    key: "session:s2",
    side: "right",
  };
  assert.equal(
    dropResult({
      ...base,
      viewId: "v1",
      payload: { pane: { viewId: "v2", key: "session:s1" } },
    }),
    two,
  );
  assert.deepEqual(
    dropResult({
      ...base,
      viewId: "v1",
      payload: { pane: { viewId: "v1", key: "session:s1" } },
    }),
    split("row", pane("s2"), pane("s1")),
  );
});

const a1 = { id: "a1", model: { connectionId: "router" } };
test("hovering: an item as dragged, an agent's first chat, null for an agent without one", () => {
  const lists = {
    assistants: [a1],
    conversations: [{ id: "c1", assistantId: "a1", main: true }],
  };
  assert.deepEqual(hoverItemOf({ item: item("s1") }, lists), item("s1"));
  assert.deepEqual(hoverItemOf({ agent: { assistantId: "a1" } }, lists), {
    kind: "chat",
    assistantId: "a1",
    conversationId: "c1",
  });
  assert.equal(
    hoverItemOf({ agent: { assistantId: "a1" } }, { ...lists, conversations: [] }),
    null,
  );
  assert.equal(hoverItemOf({ pane: { viewId: "v", key: "k" } }, lists), null);
});

test("a dropped agent without a chat opens one", async () => {
  assert.deepEqual(
    await itemForPayload(
      { agent: { assistantId: "a1" } },
      {
        assistants: [a1],
        conversations: [],
        refresh: async () => {},
        open: async () => ({ id: "c9" }),
      },
    ),
    { kind: "chat", assistantId: "a1", conversationId: "c9" },
  );
  assert.deepEqual(
    await itemForPayload({ item: item("s1") }, { open: () => assert.fail() }),
    item("s1"),
  );
});

test("a dropped session carries the tab it was last shown on; shells never get chat", async () => {
  const memory = new SessionViewMemory(() => null);
  const claude = { id: "s1", tool: "claude", createdAt: "t" },
    shell = { id: "s2", tool: "shell" },
    login = { id: "s3", tool: "codex", purpose: "login" };
  const sessions = [claude, shell, login];
  assert.deepEqual(withRememberedTab(item("s1"), sessions, memory), {
    ...item("s1"),
    tab: "terminal",
  });
  memory.remember(claude, "reader");
  assert.equal(withRememberedTab(item("s1"), sessions, memory).tab, "chat");
  assert.equal(withRememberedTab(item("s2"), sessions, memory).tab, "terminal");
  assert.equal(withRememberedTab(item("s3"), sessions, memory).tab, "terminal");
  memory.remember(shell, "files");
  assert.equal(withRememberedTab(item("s2"), sessions, memory).tab, "files");
  // Unknown sessions and chats stay as dragged.
  assert.deepEqual(withRememberedTab(item("gone"), sessions, memory), item("gone"));
  const chat = { kind: "chat", assistantId: "a", conversationId: "c" };
  assert.equal(withRememberedTab(chat, sessions, memory), chat);
  // itemForPayload hands sessions through the tab's shared memory.
  const dropped = await itemForPayload({ item: item("s1") }, { sessions });
  assert.ok(["terminal", "chat", "files"].includes(dropped.tab));
});
