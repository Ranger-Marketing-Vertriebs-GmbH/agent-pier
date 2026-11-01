import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { checkLayout } from "../../server/features/views/view-layout.js";
import {
  MAX_PANES,
  dropItem,
  itemKey,
  movePane,
  paneCount,
  panes,
  removePane,
  setRatio,
  setTab,
  wouldAdd,
} from "../../web/features/views/split-tree.js";

const items = [
  ...[1, 2, 3, 4].map((n) => ({ kind: "session", id: `s${n}` })),
  ...[1, 2, 3, 4].map((n) => ({
    kind: "chat",
    assistantId: "a",
    conversationId: `c${n}`,
  })),
];
const sides = fc.constantFrom("left", "right", "top", "bottom", "center");
const index = fc.nat({ max: 7 });
const operation = fc.oneof(
  fc.record({ op: fc.constant("drop"), item: index, target: index, side: sides }),
  fc.record({ op: fc.constant("move"), from: index, to: index, side: sides }),
  fc.record({ op: fc.constant("remove"), key: index }),
  fc.record({
    op: fc.constant("tab"),
    key: index,
    tab: fc.constantFrom("terminal", "chat", "files"),
  }),
  fc.record({
    op: fc.constant("ratio"),
    at: index,
    ratio: fc.oneof(
      fc.double({ min: -1, max: 2, noNaN: true }),
      fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1, 0.15, 0.85),
    ),
  }),
);

function splitPaths(node, path = [], out = []) {
  if (node?.type === "split") {
    out.push(path);
    splitPaths(node.a, [...path, "a"], out);
    splitPaths(node.b, [...path, "b"], out);
  }
  return out;
}

function wellFormed(node) {
  if (node.type === "pane") return true;
  return Boolean(node.a && node.b) && wellFormed(node.a) && wellFormed(node.b);
}

const keysOf = (layout) =>
  panes(layout)
    .map((p) => p.key)
    .sort();

/** Applies a step and asserts its no-loss invariants; returns the new layout. */
function step(layout, s) {
  const present = panes(layout);
  const pick = (n) => present[n % present.length];
  const before = keysOf(layout);
  if (s.op === "drop") {
    const item = items[s.item];
    const key = itemKey(item);
    if (layout && paneCount(layout) >= MAX_PANES && wouldAdd(layout, item)) return layout;
    const target = layout ? pick(s.target) : null;
    const next = dropItem(layout, item, target?.key ?? null, s.side);
    // A new item dropped on the centre replaces the target pane.
    const replaced = !before.includes(key) && layout && s.side === "center";
    const expected = before.includes(key)
      ? before
      : [...before.filter((k) => !(replaced && k === target.key)), key].sort();
    assert.deepEqual(keysOf(next), expected);
    return next;
  }
  if (!layout) return layout;
  if (s.op === "move") {
    const from = pick(s.from),
      to = pick(s.to);
    const next = movePane(layout, from.key, to.key, s.side);
    assert.deepEqual(keysOf(next), before);
    const moved = panes(next).find((p) => p.key === from.key);
    assert.equal(moved.tab, from.tab);
    if (s.side === "center" && from.key !== to.key)
      assert.equal(panes(next).find((p) => p.key === to.key).tab, to.tab);
    return next;
  }
  if (s.op === "remove") {
    const key = pick(s.key).key;
    const next = removePane(layout, key);
    assert.deepEqual(
      keysOf(next),
      before.filter((k) => k !== key),
    );
    return next;
  }
  if (s.op === "tab") {
    const next = setTab(layout, pick(s.key).key, s.tab);
    assert.deepEqual(keysOf(next), before);
    return next;
  }
  const paths = splitPaths(layout);
  if (!paths.length) return layout;
  const next = setRatio(layout, paths[s.at % paths.length], s.ratio);
  assert.deepEqual(keysOf(next), before);
  return next;
}

function run(steps, each) {
  let layout = null;
  for (const s of steps) {
    layout = step(layout, s);
    if (layout) {
      assert.ok(wellFormed(layout));
      assert.ok(paneCount(layout) <= MAX_PANES);
      assert.deepEqual(checkLayout(layout), layout);
    }
    each?.(layout);
  }
  return layout;
}

test("any operation sequence keeps the tree valid for the server and loses no pane", () => {
  check(fc.property(fc.array(operation, { maxLength: 40 }), (steps) => void run(steps)));
});

test("removing every pane yields null", () => {
  check(
    fc.property(fc.array(operation, { maxLength: 30 }), (steps) => {
      let layout = run(steps);
      for (const pane of panes(layout)) layout = removePane(layout, pane.key);
      assert.equal(layout, null);
    }),
  );
});
