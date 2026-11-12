import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  dropTarget,
  placeAgent,
  positionOf,
  sortByOrder,
  stepAgent,
} from "../../web/features/assistants/order/agent-order.js";

const entry = (id, section = "ungrouped", kind = "own", fixed = false) => ({
  id,
  section,
  kind,
  fixed,
});
const flat = ["a", "b", "c", "d"].map((id) => entry(id));

test("positioned agents come first in their order, the rest keep theirs", () => {
  const items = ["n1", "a", "n2", "b"].map((id) => ({ id }));
  assert.deepEqual(
    sortByOrder(items, ["b", "gone", "a"]).map((item) => item.id),
    ["b", "a", "n1", "n2"],
  );
  assert.deepEqual(
    sortByOrder(items).map((item) => item.id),
    ["n1", "a", "n2", "b"],
  );
});

test("a drop places the agent before a row or after the last of its kind", () => {
  assert.deepEqual(placeAgent(flat, "d", { section: "ungrouped", beforeId: "a" }), [
    "d",
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(placeAgent(flat, "a", { section: "ungrouped", beforeId: null }), [
    "b",
    "c",
    "d",
    "a",
  ]);
  // Dropping where it already is changes nothing.
  assert.equal(placeAgent(flat, "b", { section: "ungrouped", beforeId: "c" }), null);
  assert.equal(placeAgent(flat, "b", { section: "ungrouped", beforeId: "b" }), null);
  assert.equal(placeAgent(flat, "d", { section: "ungrouped", beforeId: null }), null);
});

test("a drop into another group lands there; a permanent member stays with its lead's group", () => {
  const display = [
    entry("w1", "work"),
    entry("w2", "work"),
    entry("u1"),
    entry("m", "ungrouped", "own", true),
  ];
  assert.deepEqual(placeAgent(display, "u1", { section: "work", beforeId: "w2" }), [
    "w1",
    "u1",
    "w2",
    "m",
  ]);
  assert.deepEqual(placeAgent(display, "u1", { section: "work", beforeId: null }), [
    "w1",
    "w2",
    "u1",
    "m",
  ]);
  // An empty group takes the agent; the order of other sections stays.
  assert.ok(placeAgent(display, "w1", { section: "empty", beforeId: null }));
  assert.equal(placeAgent(display, "m", { section: "work", beforeId: null }), null);
});

test("Move up and Move down stay inside the section and kind", () => {
  const display = [entry("a"), entry("b"), entry("x", "ungrouped", "user"), entry("c")];
  assert.deepEqual(stepAgent(display, "b", "up"), ["b", "a", "x", "c"]);
  assert.deepEqual(stepAgent(display, "b", "down"), ["a", "x", "c", "b"]);
  assert.equal(stepAgent(display, "a", "up"), null);
  assert.equal(stepAgent(display, "c", "down"), null);
  assert.equal(stepAgent(display, "x", "up"), null);
  assert.deepEqual(positionOf(display, "c"), { position: 3, count: 3 });
});

test("the drop target follows the row midpoints of the section under the pointer", () => {
  const rows = [
    { id: "a", section: "s", kind: "own", top: 0, bottom: 40 },
    { id: "b", section: "s", kind: "own", top: 40, bottom: 80 },
    { id: "u", section: "s", kind: "user", top: 80, bottom: 120 },
    { id: "h", section: "t", kind: "own", top: 150, bottom: 150 },
  ];
  const sections = [
    { key: "s", top: 0, bottom: 130 },
    { key: "t", top: 130, bottom: 160 },
  ];
  const at = (y, kind = "own") =>
    dropTarget({ source: { id: "z", kind }, rows, sections, y });
  assert.deepEqual(at(10), { section: "s", beforeId: "a", afterId: null });
  assert.deepEqual(at(50), { section: "s", beforeId: "b", afterId: null });
  assert.deepEqual(at(70), { section: "s", beforeId: null, afterId: "b" });
  assert.deepEqual(at(10, "user"), { section: "s", beforeId: "u", afterId: null });
  // A folded section shows no rows: the agent goes last.
  assert.deepEqual(at(140), { section: "t", beforeId: null, afterId: null });
  assert.equal(at(500), null);
});

test("any drop keeps every agent exactly once and moves only the dragged one", () => {
  const ids = ["a", "b", "c", "d", "e"];
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("s", "t"), { minLength: 5, maxLength: 5 }),
      fc.constantFrom(...ids),
      fc.option(fc.constantFrom(...ids), { nil: null }),
      fc.constantFrom("s", "t"),
      (sections, id, beforeId, section) => {
        const display = ids.map((other, index) => entry(other, sections[index]));
        const before = display.find((other) => other.id === beforeId);
        const target = before && before.section !== section ? null : beforeId;
        const next = placeAgent(display, id, { section, beforeId: target });
        if (!next) return;
        assert.deepEqual([...next].sort(), ids);
        const rest = (list) => list.filter((other) => other !== id);
        assert.deepEqual(rest(next), rest(ids));
      },
    ),
  );
});
