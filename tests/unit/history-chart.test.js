import test from "node:test";
import assert from "node:assert/strict";
import {
  GAP_MS,
  lineSegments,
  nearestIndex,
  timeGaps,
} from "../../web/components/history-chart.js";

const at = (seconds, values = {}) => ({ t: seconds * 1000, cpu: 10, ...values });
const times = (segments) => segments.map((items) => items.map((point) => point.t / 1000));

test("a gap is anything longer than 90 seconds between two points", () => {
  assert.equal(GAP_MS, 90_000);
  const points = [at(0), at(60), at(150), at(300), at(360)];
  assert.deepEqual(times(lineSegments(points, "cpu")), [
    [0, 60, 150],
    [300, 360],
  ]);
  assert.deepEqual(timeGaps(points), [{ from: 150_000, to: 300_000 }]);
});

test("a missing value breaks the line without marking a gap", () => {
  const points = [at(0), at(30, { cpu: null }), at(60), at(90, { cpu: Number.NaN })];
  assert.deepEqual(times(lineSegments(points, "cpu")), [[0], [60]]);
  assert.deepEqual(timeGaps(points), []);
});

test("a gap after a missing value still splits the following run", () => {
  const points = [at(0), at(30, { cpu: null }), at(200), at(230)];
  assert.deepEqual(times(lineSegments(points, "cpu")), [[0], [200, 230]]);
  assert.deepEqual(timeGaps(points), [{ from: 30_000, to: 200_000 }]);
});

test("each series is split on its own field", () => {
  const points = [at(0, { memory: 1 }), at(30, { memory: null }), at(60, { memory: 2 })];
  assert.deepEqual(times(lineSegments(points, "cpu")), [[0, 30, 60]]);
  assert.deepEqual(times(lineSegments(points, "memory")), [[0], [60]]);
});

test("no points give no segments and no gaps; a custom gap applies", () => {
  assert.deepEqual(lineSegments([], "cpu"), []);
  assert.deepEqual(timeGaps([]), []);
  const points = [at(0), at(20), at(40)];
  assert.deepEqual(times(lineSegments(points, "cpu", 10_000)), [[0], [20], [40]]);
  assert.equal(timeGaps(points, 10_000).length, 2);
});

test("the nearest point to a time is found, ties choose the earlier one", () => {
  const points = [at(0), at(60), at(120)];
  assert.equal(nearestIndex(points, -5_000), 0);
  assert.equal(nearestIndex(points, 29_000), 0);
  assert.equal(nearestIndex(points, 30_000), 0);
  assert.equal(nearestIndex(points, 31_000), 1);
  assert.equal(nearestIndex(points, 500_000), 2);
  assert.equal(nearestIndex([], 0), -1);
});
