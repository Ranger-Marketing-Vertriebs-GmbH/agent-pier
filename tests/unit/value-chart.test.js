import test from "node:test";
import assert from "node:assert/strict";
import { chartScale } from "../../web/components/value-chart.js";

const points = (...values) => values.map((value, i) => ({ label: `${i}`, value }));

test("the y axis runs from 0 to the highest value with room at both ends", () => {
  const { min, max, y } = chartScale(points(10, 50, 30));
  assert.equal(min, 0);
  assert.equal(max, 50);
  assert.equal(y(0), 96);
  assert.equal(y(50), 4);
});

test("negative values move the axis down; equal values never divide by zero", () => {
  assert.equal(chartScale(points(-20, 10)).min, -20);
  const flat = chartScale(points(0, 0));
  assert.equal(flat.max, 1);
  assert.ok(Number.isFinite(flat.y(0)));
});

test("a line runs edge to edge, bars sit in equal slots", () => {
  const line = chartScale(points(1, 2, 3));
  assert.deepEqual([0, 1, 2].map(line.x), [0, 50, 100]);
  assert.equal(chartScale(points(1)).x(0), 50);
  const bars = chartScale(points(1, 2), { bar: true });
  assert.equal(bars.step, 50);
  assert.deepEqual([0, 1].map(bars.x), [25, 75]);
});
