import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PANES,
  MIN_PANE,
  PANE_HINT_FROM,
  dropItem,
  findPane,
  firstPane,
  itemKey,
  movePane,
  paneCount,
  paneLeaf,
  panes,
  removePane,
  replaceItem,
  replacePane,
  setRatio,
  setTab,
  splitPane,
  twoPaneLayout,
  wouldAdd,
} from "../../web/features/views/split-tree.js";

const s1 = { kind: "session", id: "s1" },
  s2 = { kind: "session", id: "s2" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };
const pair = splitPane(paneLeaf(s1), "session:s1", "right", paneLeaf(c1));

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

test("constants and leaves", () => {
  assert.equal(MAX_PANES, 6);
  assert.equal(PANE_HINT_FROM, 5);
  assert.deepEqual(MIN_PANE, { width: 280, height: 220 });
  assert.equal(itemKey(s1), "session:s1");
  assert.equal(itemKey(c1), "chat:a1:c1");
  assert.deepEqual(paneLeaf(c1), { type: "pane", item: c1 });
  assert.deepEqual(paneLeaf(c1, "files"), { type: "pane", item: c1 });
  assert.deepEqual(paneLeaf(s1), { type: "pane", item: s1, tab: "terminal" });
  assert.deepEqual(paneLeaf(s1, "files"), { type: "pane", item: s1, tab: "files" });
  // A dropped item's remembered tab (drop-rules.js) stays on the leaf, not the item.
  assert.deepEqual(paneLeaf({ ...s1, tab: "chat" }), {
    type: "pane",
    item: s1,
    tab: "chat",
  });
  assert.equal(paneLeaf({ ...s1, tab: "chat" }, "files").tab, "files");
});

test("queries", () => {
  assert.deepEqual(panes(null), []);
  assert.deepEqual(panes(pair), [
    { key: "session:s1", item: s1, tab: "terminal", path: ["a"] },
    { key: "chat:a1:c1", item: c1, tab: undefined, path: ["b"] },
  ]);
  assert.equal(paneCount(pair), 2);
  assert.equal(paneCount(null), 0);
  assert.deepEqual(findPane(pair, "chat:a1:c1"), ["b"]);
  assert.equal(findPane(pair, "session:zz"), null);
  assert.equal(firstPane(pair).key, "session:s1");
  assert.equal(firstPane(null), null);
  assert.equal(wouldAdd(pair, s1), false);
  assert.equal(wouldAdd(pair, s2), true);
});

test("splitPane puts the new leaf on the chosen side", () => {
  assert.deepEqual(splitPane(paneLeaf(s1), "session:s1", "left", paneLeaf(s2)), {
    type: "split",
    dir: "row",
    ratio: 0.5,
    a: { type: "pane", item: s2, tab: "terminal" },
    b: { type: "pane", item: s1, tab: "terminal" },
  });
  assert.equal(splitPane(paneLeaf(s1), "session:s1", "bottom", paneLeaf(c1)).dir, "col");
  assert.deepEqual(splitPane(paneLeaf(s1), "session:s1", "top", paneLeaf(c1)).a.item, c1);
  const layout = paneLeaf(s1);
  assert.equal(splitPane(layout, "session:none", "left", paneLeaf(s2)), layout);
});

test("splitPane nests inside an existing split", () => {
  const three = splitPane(pair, "chat:a1:c1", "bottom", paneLeaf(s2));
  assert.deepEqual(
    panes(three).map((p) => [p.key, p.path.join("")]),
    [
      ["session:s1", "a"],
      ["chat:a1:c1", "ba"],
      ["session:s2", "bb"],
    ],
  );
  assert.equal(three.a, pair.a);
});

test("replacePane swaps the leaf", () => {
  assert.deepEqual(
    panes(replacePane(pair, "chat:a1:c1", paneLeaf(s2))).map((p) => p.key),
    ["session:s1", "session:s2"],
  );
});

test("removePane lets the sibling take the parent's place", () => {
  assert.deepEqual(removePane(pair, "chat:a1:c1"), paneLeaf(s1));
  assert.equal(removePane(paneLeaf(s1), "session:s1"), null);
  assert.equal(removePane(pair, "session:zz"), pair);
  const three = splitPane(pair, "chat:a1:c1", "bottom", paneLeaf(s2));
  assert.deepEqual(
    removePane(three, "chat:a1:c1"),
    splitPane(paneLeaf(s1), "session:s1", "right", paneLeaf(s2)),
  );
});

test("dropItem handles empty views, new items, moves and itself", () => {
  assert.deepEqual(dropItem(null, c1, null, "center"), paneLeaf(c1));
  assert.equal(dropItem(pair, c1, "chat:a1:c1", "left"), pair);
  assert.deepEqual(
    panes(dropItem(pair, s2, "chat:a1:c1", "right")).map((p) => p.key),
    ["session:s1", "chat:a1:c1", "session:s2"],
  );
  assert.deepEqual(
    panes(dropItem(pair, c1, "session:s1", "top")).map((p) => p.key),
    ["chat:a1:c1", "session:s1"],
  );
  assert.deepEqual(
    panes(dropItem(pair, s2, "session:s1", "center")).map((p) => p.key),
    ["session:s2", "chat:a1:c1"],
  );
  assert.equal(dropItem(pair, s2, "session:none", "left"), pair);
});

test("dropItem on the centre swaps a present item and loses no pane", () => {
  const swapped = dropItem(pair, c1, "session:s1", "center");
  assert.deepEqual(
    panes(swapped).map((p) => p.key),
    ["chat:a1:c1", "session:s1"],
  );
  const three = splitPane(pair, "chat:a1:c1", "bottom", paneLeaf(s2));
  assert.equal(paneCount(dropItem(three, s1, "session:s2", "center")), 3);
});

test("setRatio ignores non-finite values, setTab unknown tabs, paneLeaf extra fields", () => {
  assert.equal(setRatio(pair, [], Number.NaN), pair);
  assert.equal(setRatio(pair, [], Infinity), pair);
  assert.equal(setTab(pair, "session:s1", "bogus"), pair);
  assert.deepEqual(paneLeaf({ ...s1, extra: 1 }).item, s1);
  assert.deepEqual(paneLeaf({ ...c1, extra: 1 }).item, c1);
});

test("dropItem moves an existing item together with its tab", () => {
  const files = setTab(pair, "session:s1", "files");
  const moved = dropItem(files, s1, "chat:a1:c1", "right");
  assert.deepEqual(
    panes(moved).map((p) => [p.key, p.tab]),
    [
      ["chat:a1:c1", undefined],
      ["session:s1", "files"],
    ],
  );
});

test("movePane moves next to the target and swaps on centre", () => {
  assert.deepEqual(
    panes(movePane(pair, "session:s1", "chat:a1:c1", "right")).map((p) => p.key),
    ["chat:a1:c1", "session:s1"],
  );
  assert.deepEqual(
    panes(
      movePane(setTab(pair, "session:s1", "files"), "session:s1", "chat:a1:c1", "center"),
    ).map((p) => [p.key, p.tab]),
    [
      ["chat:a1:c1", undefined],
      ["session:s1", "files"],
    ],
  );
  assert.equal(movePane(pair, "session:s1", "session:s1", "left"), pair);
  assert.equal(movePane(pair, "session:zz", "chat:a1:c1", "left"), pair);
});

test("setRatio clamps and keeps the reference when unchanged", () => {
  assert.equal(setRatio(pair, [], 0.99).ratio, 0.85);
  assert.equal(setRatio(pair, [], 0.01).ratio, 0.15);
  assert.equal(setRatio(pair, [], 0.5), pair);
  const three = splitPane(pair, "chat:a1:c1", "bottom", paneLeaf(s2));
  assert.equal(setRatio(three, ["b"], 0.3).b.ratio, 0.3);
  assert.equal(setRatio(three, ["b"], 0.3).a, three.a);
});

test("setTab changes sessions only", () => {
  assert.equal(setTab(pair, "session:s1", "chat").a.tab, "chat");
  assert.equal(setTab(pair, "session:s1", "terminal"), pair);
  assert.equal(setTab(pair, "chat:a1:c1", "files"), pair);
  assert.equal(setTab(pair, "session:zz", "files"), pair);
});

test("replaceItem swaps the item unless it is already in the layout", () => {
  assert.equal(replaceItem(pair, "chat:a1:c1", s1), pair);
  assert.deepEqual(
    panes(replaceItem(pair, "chat:a1:c1", s2)).map((p) => p.key),
    ["session:s1", "session:s2"],
  );
  assert.equal(replaceItem(pair, "session:zz", s2), pair);
});

test("twoPaneLayout counts centre as right", () => {
  assert.deepEqual(twoPaneLayout(s1, c1, "center"), pair);
  assert.deepEqual(twoPaneLayout(s1, c1, "top").a.item, c1);
});

test("twoPaneLayout keeps the tab the shown session is on", () => {
  assert.equal(twoPaneLayout(s1, c1, "right", "files").a.tab, "files");
  assert.equal(twoPaneLayout(s1, c1, "right").a.tab, "terminal");
});

test("operations never mutate their input", () => {
  const frozen = deepFreeze(pair);
  assert.doesNotThrow(() => splitPane(frozen, "chat:a1:c1", "right", paneLeaf(s2)));
  assert.doesNotThrow(() => removePane(frozen, "chat:a1:c1"));
  assert.doesNotThrow(() => movePane(frozen, "session:s1", "chat:a1:c1", "center"));
  assert.doesNotThrow(() => setRatio(frozen, [], 0.3));
  assert.doesNotThrow(() => setTab(frozen, "session:s1", "files"));
  assert.doesNotThrow(() => dropItem(frozen, s2, "session:s1", "left"));
});

test("a dropped session lands on its remembered tab, in a view and a new two-pane view", () => {
  const layout = dropItem(paneLeaf(s1), { ...s2, tab: "chat" }, "session:s1", "right");
  assert.deepEqual(layout.b, { type: "pane", item: s2, tab: "chat" });
  assert.equal(dropItem(null, { ...s2, tab: "files" }).tab, "files");
  const fresh = twoPaneLayout(s1, { ...s2, tab: "chat" }, "right", "files");
  assert.deepEqual([fresh.a.tab, fresh.b.tab], ["files", "chat"]);
});
