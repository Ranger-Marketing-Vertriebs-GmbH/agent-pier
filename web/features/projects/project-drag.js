// Drag and drop on the projects list (useProjectDrag.js): the pure parts. Rectangles
// are viewport coordinates as getBoundingClientRect() returns them.

/** A press turns into a drag once the pointer moved this far (px). */
export const DRAG_THRESHOLD = 4;
/** Hovering a collapsed group this long during a drag opens it (ms). */
export const HOVER_OPEN_MS = 600;
/** The list scrolls while the pointer is this close to its top or bottom (px). */
export const SCROLL_EDGE = 40;
const SCROLL_MAX = 16;

export function passedThreshold(origin, point) {
  return Math.hypot(point.x - origin.x, point.y - origin.y) >= DRAG_THRESHOLD;
}

const inside = (point, rect) =>
  point.x >= rect.left &&
  point.x <= rect.right &&
  point.y >= rect.top &&
  point.y <= rect.bottom;

/** The section under `y`, or null. */
export function sectionAt(sections, y) {
  return sections.find((entry) => y >= entry.top && y < entry.bottom) || null;
}

/**
 * Where a drop at `point` would land, or null when it would change nothing.
 * `source` is `{ type: "project", groupId }` (its current group, null for none) or
 * `{ type: "group", groupId }`. `list` is the scroller's rectangle; `sections` lists
 * the rendered sections in order as `{ key, groupId, top, bottom }` (groupId null for
 * "No group"). A project lands in the section under the pointer:
 * `{ type: "assign", groupId, key }`. A group lands between groups by their midpoints:
 * `{ type: "reorder", index, before }`, where `index` is its new position and `before`
 * the group it is drawn in front of (the group count: after the last one).
 */
export function dropTarget({ source, point, list, sections }) {
  if (!source || !inside(point, list)) return null;
  if (source.type === "project") {
    const hit = sectionAt(sections, point.y);
    if (!hit || hit.groupId === undefined || hit.groupId === source.groupId) return null;
    return { type: "assign", groupId: hit.groupId, key: hit.key };
  }
  const groups = sections.filter((entry) => entry.groupId);
  const from = groups.findIndex((entry) => entry.groupId === source.groupId);
  if (from < 0) return null;
  const before = groups.filter(
    (entry) => point.y >= (entry.top + entry.bottom) / 2,
  ).length;
  const index = before > from ? before - 1 : before;
  return index === from ? null : { type: "reorder", index, before };
}

export function sameTarget(a, b) {
  if (!a || !b) return a === b;
  return a.type === b.type && a.groupId === b.groupId && a.before === b.before;
}

/**
 * Pixels to scroll the list this frame: negative near the top, positive near the
 * bottom, 0 while the pointer is beside the list.
 */
export function autoScrollStep({ x, y }, list) {
  if (x < list.left || x > list.right) return 0;
  const speed = (depth) =>
    Math.ceil((SCROLL_MAX * Math.min(depth, SCROLL_EDGE)) / SCROLL_EDGE);
  if (y < list.top + SCROLL_EDGE) return -speed(list.top + SCROLL_EDGE - y);
  if (y > list.bottom - SCROLL_EDGE) return speed(y - (list.bottom - SCROLL_EDGE));
  return 0;
}
