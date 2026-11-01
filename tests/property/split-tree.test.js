import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import {
  MAX_PANES,
  dropItem,
  itemKey,
  movePane,
  paneCount,
  panes,
  removePane,
  setRatio,
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
    op: fc.constant("ratio"),
    at: index,
    ratio: fc.double({ min: -1, max: 2, noNaN: true }),
  }),
);

function ratios(node, out = []) {
  if (node?.type === "split") {
    out.push(node.ratio);
    ratios(node.a, out);
    ratios(node.b, out);
  }
  return out;
}

function apply(layout, step) {
  const present = panes(layout);
  const pick = (n) => present[n % Math.max(present.length, 1)];
  if (step.op === "drop") {
    const item = items[step.item];
    if (layout && paneCount(layout) >= MAX_PANES && wouldAdd(layout, item)) return layout;
    return dropItem(layout, item, pick(step.target)?.key ?? null, step.side);
  }
  if (!layout) return layout;
  if (step.op === "move")
    return movePane(layout, pick(step.from).key, pick(step.to).key, step.side);
  if (step.op === "remove") return removePane(layout, pick(step.key).key);
  const dividers =
    present.length > 1 ? panes(layout).map((p) => p.path.slice(0, -1)) : [];
  const path = dividers.length ? dividers[step.at % dividers.length] : [];
  return layout.type === "split" ? setRatio(layout, path, step.ratio) : layout;
}

test("any operation sequence keeps the view tree consistent", () => {
  check(
    fc.property(fc.array(operation, { maxLength: 40 }), (steps) => {
      let layout = null;
      for (const step of steps) {
        layout = apply(layout, step);
        const keys = panes(layout).map((p) => p.key);
        assert.equal(new Set(keys).size, keys.length);
        assert.equal(paneCount(layout), keys.length);
        assert.ok(keys.length <= MAX_PANES);
        for (const ratio of ratios(layout)) assert.ok(ratio >= 0.15 && ratio <= 0.85);
      }
    }),
  );
});

test("removing every pane yields null", () => {
  check(
    fc.property(fc.array(operation, { maxLength: 30 }), (steps) => {
      let layout = null;
      for (const step of steps) layout = apply(layout, step);
      for (const pane of panes(layout)) layout = removePane(layout, pane.key);
      assert.equal(layout, null);
    }),
  );
});

test("dropping an item on a pane puts it in the layout exactly once", () => {
  check(
    fc.property(
      fc.array(operation, { maxLength: 20 }),
      index,
      sides,
      (steps, n, side) => {
        let layout = null;
        for (const step of steps) layout = apply(layout, step);
        if (!layout || (paneCount(layout) >= MAX_PANES && wouldAdd(layout, items[n])))
          return;
        const target = panes(layout)[0].key;
        const next = dropItem(layout, items[n], target, side);
        assert.equal(panes(next).filter((p) => p.key === itemKey(items[n])).length, 1);
      },
    ),
  );
});
