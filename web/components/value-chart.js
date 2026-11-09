// Pure scale of ValueChart (tests/unit/value-chart.test.js).

/**
 * The scale of a ValueChart over `points` (`[{ value }]`) in a 100 × 100 box: `min`
 * and `max` of the y axis (from 0, or the lowest negative value, to the highest
 * value; never an empty range), `y(value)` with a little room at top and bottom,
 * `x(index)` (a line runs edge to edge; bars sit in the middle of equal slots, `bar`)
 * and `step`, one slot's width.
 */
export function chartScale(points, { bar = false } = {}) {
  const values = points.map((point) => point.value).filter(Number.isFinite);
  const min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (max === min) max = min + 1;
  const count = Math.max(1, points.length);
  const step = 100 / count;
  const x = bar
    ? (index) => step * (index + 0.5)
    : (index) => (count > 1 ? (index * 100) / (count - 1) : 50);
  const y = (value) => 96 - ((value - min) / (max - min)) * 92;
  return { min, max, x, y, step };
}
