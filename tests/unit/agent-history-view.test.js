import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyHistoryView,
  shownHistory,
  withLive,
  withOlder,
} from "../../web/features/assistants/agent-history-view.js";

const rows = (...ids) => ids.map((id) => ({ id, role: "user", text: id }));
const live = (ids, nextBefore = "100", extra = {}) => ({
  messages: rows(...ids),
  requests: [],
  stale: false,
  nextBefore,
  sync: { mode: "full", cursor: ids.join("") },
  ...extra,
});
const ids = (view) => shownHistory(view).messages.map((m) => m.id);

test("the live window advances while loaded older pages stay above it", () => {
  let view = withLive(emptyHistoryView, live(["c", "d", "e"]));
  view = withOlder(view, { messages: rows("a", "b"), nextBefore: "200" });
  assert.deepEqual(ids(view), ["a", "b", "c", "d", "e"]);
  assert.equal(shownHistory(view).nextBefore, "200");
  // Two new rows push c and d out of the window: they stay where they were.
  view = withLive(view, live(["e", "f", "g"], "102", { queued: { text: "q" } }));
  assert.deepEqual(ids(view), ["a", "b", "c", "d", "e", "f", "g"]);
  // Live metadata comes from the newest window; paging continues from the older pages.
  assert.deepEqual(shownHistory(view).queued, { text: "q" });
  assert.equal(shownHistory(view).nextBefore, "200");
});

test("an overlapping older page adds no duplicates and the newer place wins", () => {
  let view = withLive(emptyHistoryView, live(["c", "d"]));
  view = withLive(view, live(["d", "e"], "101"));
  // Read with the offset of the moved window, the page repeats c and d.
  view = withOlder(view, { messages: rows("a", "b", "c", "d"), nextBefore: null });
  assert.deepEqual(ids(view), ["a", "b", "c", "d", "e"]);
  assert.equal(shownHistory(view).nextBefore, null);
  // A row the live window shows again keeps the window's place.
  view = withLive(view, live(["b", "d", "e"], "101"));
  assert.deepEqual(ids(view), ["a", "c", "b", "d", "e"]);
});

test("without older pages the live window pages from its own nextBefore", () => {
  const view = withLive(emptyHistoryView, live(["a", "b"]));
  assert.equal(shownHistory(view).nextBefore, "100");
  assert.deepEqual(ids(view), ["a", "b"]);
});

test("a window that reaches the start or jumps past the shown rows starts over", () => {
  let view = withLive(emptyHistoryView, live(["c", "d"]));
  view = withOlder(view, { messages: rows("a", "b"), nextBefore: null });
  // The whole conversation fits again (rows were removed): the window alone stands.
  assert.deepEqual(ids(withLive(view, live(["a", "d"], null))), ["a", "d"]);
  // A burst larger than the window cannot be joined without a gap.
  const jumped = withLive(view, live(["x", "y"], "300"));
  assert.deepEqual(ids(jumped), ["x", "y"]);
  assert.equal(shownHistory(jumped).nextBefore, "300");
});

test("an empty view shows nothing and pages nowhere", () => {
  const shown = shownHistory(emptyHistoryView);
  assert.deepEqual(shown.messages, []);
  assert.equal(shown.nextBefore, null);
});
