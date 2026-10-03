import { test } from "node:test";
import assert from "node:assert/strict";
import {
  restoreScrollAnchor,
  scrollAnchor,
} from "../../web/features/chat/chat-scroll-anchor.js";

// A scroll container whose rows sit at fixed content positions.
// A row with `parent` is nested inside the row with that id (an expanded group).
function view(rows, { top = 100, scrollTop = 0 } = {}) {
  const nodes = new Map();
  const element = {
    scrollTop,
    getBoundingClientRect: () => ({ top }),
    contains: (node) => [...nodes.values()].includes(node),
    querySelectorAll: () => [...nodes.values()],
  };
  for (const row of rows) {
    nodes.set(row.key ?? row.id, {
      dataset: { messageId: row.id },
      parentElement: {
        closest: () => (row.parent ? nodes.get(row.parent) : null),
      },
      getBoundingClientRect: () => ({
        top: top + row.at - element.scrollTop,
        height: row.height ?? 40,
      }),
    });
  }
  return element;
}

test("the anchor is the first visible row with its viewport offset", () => {
  const element = view(
    [
      { id: "hidden", at: 0, height: 0 },
      { id: "above", at: 100 },
      { id: "seen", at: 230 },
    ],
    { scrollTop: 200 },
  );
  assert.deepEqual(scrollAnchor(element, false), {
    anchorId: "seen",
    offset: 30,
    stick: false,
  });
});

test("a partly visible row anchors with a negative offset", () => {
  const element = view(
    [
      { id: "cut", at: 180 },
      { id: "seen", at: 230 },
    ],
    { scrollTop: 200 },
  );
  assert.deepEqual(scrollAnchor(element, false), {
    anchorId: "cut",
    offset: -20,
    stick: false,
  });
});

test("a tall final row starting above the viewport keeps the reading position", () => {
  const element = view(
    [
      { id: "earlier", at: 0 },
      { id: "long", at: 40, height: 3000 },
    ],
    { scrollTop: 1500 },
  );
  const saved = scrollAnchor(element, false);
  assert.deepEqual(saved, { anchorId: "long", offset: -1460, stick: false });
  element.scrollTop = 0;
  assert.equal(restoreScrollAnchor(element, saved), true);
  assert.equal(element.scrollTop, 1500);
});

test("rows nested in an expanded group never anchor; the group does", () => {
  const element = view(
    [
      { id: "t1", key: "group", at: 0, height: 400 },
      { id: "t1", key: "inner-1", parent: "group", at: 30, height: 100 },
      { id: "t2", key: "inner-2", parent: "group", at: 130, height: 100 },
      { id: "after", at: 400 },
    ],
    { scrollTop: 140 },
  );
  const saved = scrollAnchor(element, false);
  assert.deepEqual(saved, { anchorId: "t1", offset: -140, stick: false });
  element.scrollTop = 0;
  assert.equal(restoreScrollAnchor(element, saved), true);
  assert.equal(element.scrollTop, 140);
  assert.equal(restoreScrollAnchor(element, { anchorId: "t2", offset: 0 }), false);
});

test("without rows the anchor is empty and keeps stick", () => {
  assert.deepEqual(scrollAnchor(view([]), true), {
    anchorId: null,
    offset: 0,
    stick: true,
  });
});

test("restoring scrolls the anchor row back to its offset", () => {
  const element = view([{ id: "a" }, { id: "b", at: 600 }].map((r) => ({ at: 0, ...r })));
  assert.equal(restoreScrollAnchor(element, { anchorId: "b", offset: 25 }), true);
  assert.equal(element.scrollTop, 575);
});

test("sticky, missing or collapsed anchors fall back to the bottom", () => {
  const element = view([
    { id: "a", at: 0 },
    { id: "folded", at: 50, height: 0 },
  ]);
  assert.equal(restoreScrollAnchor(element, null), false);
  assert.equal(restoreScrollAnchor(element, { anchorId: "a", stick: true }), false);
  assert.equal(restoreScrollAnchor(element, { anchorId: "gone", offset: 0 }), false);
  assert.equal(restoreScrollAnchor(element, { anchorId: "folded", offset: 0 }), false);
  assert.equal(element.scrollTop, 0);
});
