// Horizontal rows (tabs, filter chips) fade the edge that still hides content and
// keep the active item in view by setting scrollLeft (never scrollIntoView, which
// would also scroll the page).
export const scrollEdges = ({ scrollLeft, clientWidth, scrollWidth }) => ({
  left: scrollLeft > 1,
  right: scrollLeft + clientWidth < scrollWidth - 1,
});

// Class names that drive the shared fade in scroll-fade.css.
export const edgeClassNames = (edges, ...base) =>
  [...base, edges.left ? "can-scroll-left" : "", edges.right ? "can-scroll-right" : ""]
    .filter(Boolean)
    .join(" ");

export function revealScrollLeft({
  itemLeft,
  itemWidth,
  scrollLeft,
  clientWidth,
  scrollWidth,
  margin = 48,
}) {
  let next = null;
  if (itemLeft - margin < scrollLeft) next = itemLeft - margin;
  else if (itemLeft + itemWidth + margin > scrollLeft + clientWidth)
    next = itemLeft + itemWidth + margin - clientWidth;
  if (next === null) return null;
  next = Math.min(Math.max(0, scrollWidth - clientWidth), Math.max(0, next));
  return Math.abs(next - scrollLeft) < 1 ? null : next;
}
