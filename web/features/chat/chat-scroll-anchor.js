// Only top-level rows anchor: a tool row inside a group shares the group's first
// id and loses its height when the uncontrolled group renders collapsed again.
function topLevelRows(element) {
  return [...element.querySelectorAll("[data-message-id]")].filter((row) => {
    const outer = row.parentElement?.closest?.("[data-message-id]");
    return !outer || !element.contains(outer);
  });
}

/**
 * The first at least partly visible top-level row and its distance from the
 * viewport top; negative when the row starts above it (a long final message).
 */
export function scrollAnchor(element, stick) {
  const top = element.getBoundingClientRect().top;
  for (const row of topLevelRows(element)) {
    const box = row.getBoundingClientRect();
    if (box.height > 0 && box.top + box.height > top)
      return { anchorId: row.dataset.messageId, offset: box.top - top, stick };
  }
  return { anchorId: null, offset: 0, stick };
}

/**
 * Scrolls a saved anchor row back to its offset. Returns false when the view must
 * follow the bottom instead (sticky, or the anchor row is gone).
 */
export function restoreScrollAnchor(element, scroll) {
  if (!scroll || scroll.stick || !scroll.anchorId) return false;
  const row = topLevelRows(element).find(
    (item) => item.dataset.messageId === scroll.anchorId,
  );
  if (!row || row.getBoundingClientRect().height <= 0) return false;
  const delta =
    row.getBoundingClientRect().top -
    element.getBoundingClientRect().top -
    (Number.isFinite(scroll.offset) ? scroll.offset : 0);
  element.scrollTop += delta;
  return true;
}
