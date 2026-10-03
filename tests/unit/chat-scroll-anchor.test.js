import { test } from "node:test";
import assert from "node:assert/strict";
import {
  restoreScrollAnchor,
  scrollAnchor,
} from "../../web/features/chat/chat-scroll-anchor.js";

// A scroll container whose rows sit at fixed content positions.
function view(rows, { top = 100, scrollTop = 0 } = {}) {
  const element = {
    scrollTop,
    getBoundingClientRect: () => ({ top }),
    querySelectorAll: () =>
      rows.map((row) => ({
        dataset: { messageId: row.id },
        getBoundingClientRect: () => ({
          top: top + row.at - element.scrollTop,
          height: row.height ?? 40,
        }),
      })),
  };
  return element;
}

test("the anchor is the first fully visible row with its viewport offset", () => {
  const element = view(
    [
      { id: "hidden", at: 0, height: 0 },
      { id: "cut", at: 180 },
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
