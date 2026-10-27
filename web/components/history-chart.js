// Pure helpers of HistoryChart (tests/unit/history-chart.test.js).

/** Points further apart than this mark a time without measurement; lines break there. */
export const GAP_MS = 90 * 1000;

/**
 * One series as runs of points with a finite value. A missing value ends a run, and
 * so does a time gap longer than `gapMs` before the next point.
 */
export function lineSegments(points, field, gapMs = GAP_MS) {
  const segments = [];
  let segment = [];
  let previous = null;
  const close = () => {
    if (segment.length) segments.push(segment);
    segment = [];
  };
  for (const point of points) {
    if (!Number.isFinite(point[field])) {
      close();
      previous = null;
      continue;
    }
    if (previous && point.t - previous.t > gapMs) close();
    segment.push(point);
    previous = point;
  }
  close();
  return segments;
}

/** The spans longer than `gapMs` between two consecutive points: nothing measured. */
export function timeGaps(points, gapMs = GAP_MS) {
  const gaps = [];
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1].t;
    const to = points[index].t;
    if (to - from > gapMs) gaps.push({ from, to });
  }
  return gaps;
}

/** The index of the point closest to time `t` (the earlier one on a tie), else -1. */
export function nearestIndex(points, t) {
  let best = -1;
  let distance = Infinity;
  points.forEach((point, index) => {
    const next = Math.abs(point.t - t);
    if (next < distance) {
      best = index;
      distance = next;
    }
  });
  return best;
}

/**
 * A small sparkline of `field` (0–100 %) over the `width` × `height` box: one SVG path
 * per run of points (`lineSegments`), so a gap stays a gap. The x axis spans the
 * points' own time range; a single point draws nothing.
 */
export function sparklinePaths(points, field, width, height, gapMs = GAP_MS) {
  if (points.length < 2) return [];
  const start = points[0].t;
  const span = points.at(-1).t - start || 1;
  const x = (t) => Math.round(((t - start) / span) * width * 10) / 10;
  const y = (value) =>
    Math.round((height - (Math.min(100, Math.max(0, value)) / 100) * height) * 10) / 10;
  return lineSegments(points, field, gapMs)
    .filter((segment) => segment.length > 1)
    .map((segment) =>
      segment
        .map((point, index) => `${index ? "L" : "M"}${x(point.t)} ${y(point[field])}`)
        .join(" "),
    );
}
