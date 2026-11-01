import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_ZONE,
  clampRatio,
  dividerRects,
  fits,
  minSize,
  paneRects,
  ratioBounds,
  sideAt,
  zoneRect,
} from "../../web/components/split-geometry.js";

const MIN = { width: 280, height: 220 };
const three = {
  type: "split",
  dir: "row",
  ratio: 0.5,
  a: { id: "A" },
  b: { type: "split", dir: "col", ratio: 0.25, a: { id: "B" }, b: { id: "C" } },
};

test("clampRatio keeps ratios between 0.15 and 0.85", () => {
  assert.equal(clampRatio(0.05), 0.15);
  assert.equal(clampRatio(0.9), 0.85);
  assert.equal(clampRatio(0.4), 0.4);
  assert.equal(EDGE_ZONE, 0.28);
});

test("paneRects lays leaves out in reading order as stage fractions", () => {
  assert.deepEqual(
    paneRects(three, (leaf) => leaf.id).map(({ key, path, x, y, width, height }) => [
      key,
      path.join(""),
      x,
      y,
      width,
      height,
    ]),
    [
      ["A", "a", 0, 0, 0.5, 1],
      ["B", "ba", 0.5, 0, 0.5, 0.25],
      ["C", "bb", 0.5, 0.25, 0.5, 0.75],
    ],
  );
  assert.equal(paneRects(three, (leaf) => leaf.id)[0].leaf, three.a);
  assert.deepEqual(
    paneRects({ id: "solo" }, (leaf) => leaf.id).map((r) => [r.key, r.width]),
    [["solo", 1]],
  );
});

test("dividerRects reports split lines with their node boxes", () => {
  const dividers = dividerRects(three);
  assert.deepEqual(
    dividers.map((d) => [d.path.join(""), d.dir, d.x, d.y, d.width, d.height]),
    [
      ["", "row", 0.5, 0, 0, 1],
      ["b", "col", 0.5, 0.25, 0.5, 0],
    ],
  );
  assert.deepEqual(dividers[1].box, { x: 0.5, y: 0, width: 0.5, height: 1 });
  assert.equal(dividers[1].ratio, 0.25);
  assert.deepEqual(dividerRects({ id: "solo" }), []);
});

test("minSize adds along the split axis and takes the maximum across it", () => {
  assert.deepEqual(minSize(three, MIN), { width: 560, height: 440 });
  assert.deepEqual(minSize({ id: "x" }, MIN), MIN);
});

test("ratioBounds keeps both sides at their minimum", () =>
  assert.deepEqual(ratioBounds(three, { width: 1000, height: 800 }, MIN), {
    min: 0.28,
    max: 0.72,
  }));

test("ratioBounds collapses to the proportional ratio when the container is too small", () =>
  assert.deepEqual(ratioBounds(three, { width: 400, height: 800 }, MIN), {
    min: 0.5,
    max: 0.5,
  }));

test("ratioBounds never leaves 0.15 to 0.85", () => {
  const split = { type: "split", dir: "row", ratio: 0.5, a: { id: "A" }, b: { id: "B" } };
  assert.deepEqual(ratioBounds(split, { width: 5000, height: 800 }, MIN), {
    min: 0.15,
    max: 0.85,
  });
});

test("fits refuses a third column below 840 px", () => {
  const row = {
    type: "split",
    dir: "row",
    ratio: 0.5,
    a: { id: "A" },
    b: { type: "split", dir: "row", ratio: 0.5, a: { id: "B" }, b: { id: "C" } },
  };
  assert.equal(fits(row, { width: 839, height: 600 }, MIN), false);
  assert.equal(fits(row, { width: 840, height: 600 }, MIN), true);
  assert.equal(fits(row, { width: 900, height: 219 }, MIN), false);
});

test("sideAt picks the nearest edge inside the edge zone, else the centre", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(sideAt(rect, 10, 50), "left");
  assert.equal(sideAt(rect, 90, 50), "right");
  assert.equal(sideAt(rect, 50, 5), "top");
  assert.equal(sideAt(rect, 50, 95), "bottom");
  assert.equal(sideAt(rect, 50, 50), "center");
  assert.equal(sideAt(rect, 28, 50), "center");
  assert.equal(sideAt({ left: 100, top: 50, width: 200, height: 100 }, 110, 100), "left");
});

test("zoneRect halves the rect for an edge and keeps it for the centre", () => {
  const rect = { left: 0, top: 0, width: 100, height: 60 };
  assert.deepEqual(zoneRect(rect, "right"), { left: 50, top: 0, width: 50, height: 60 });
  assert.deepEqual(zoneRect(rect, "left"), { left: 0, top: 0, width: 50, height: 60 });
  assert.deepEqual(zoneRect(rect, "top"), { left: 0, top: 0, width: 100, height: 30 });
  assert.deepEqual(zoneRect(rect, "bottom"), {
    left: 0,
    top: 30,
    width: 100,
    height: 30,
  });
  assert.deepEqual(zoneRect(rect, "center"), rect);
});

const rowOf = (count) => {
  let node = { id: "p0" };
  for (let i = 1; i < count; i += 1)
    node = { type: "split", dir: "row", ratio: 0.5, a: node, b: { id: `p${i}` } };
  return node;
};

test("minSize adds one divider gap per split", () => {
  assert.deepEqual(minSize(rowOf(6), MIN, 8), { width: 6 * 280 + 5 * 8, height: 220 });
  assert.deepEqual(minSize(rowOf(6), MIN), { width: 6 * 280, height: 220 });
});

test("fits and ratioBounds account for the divider gap", () => {
  const two = rowOf(2);
  assert.equal(fits(two, { width: 568, height: 220 }, MIN, 8), true);
  assert.equal(fits(two, { width: 567, height: 220 }, MIN, 8), false);
  const { min, max } = ratioBounds(two, { width: 1008, height: 400 }, MIN, 8);
  assert.equal(min, 280 / 1000);
  assert.equal(max, 1 - 280 / 1000);
});

test("ratioBounds with a gap collapses to one ratio when the panes just fit", () => {
  const { min, max } = ratioBounds(rowOf(2), { width: 500, height: 400 }, MIN, 8);
  assert.equal(min, max);
  assert.equal(min, 0.5);
});
