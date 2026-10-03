/** The first fully visible message row and its distance from the viewport top. */
export function scrollAnchor(element, stick) {
  const top = element.getBoundingClientRect().top;
  for (const row of element.querySelectorAll("[data-message-id]")) {
    const box = row.getBoundingClientRect();
    if (box.height > 0 && box.top >= top)
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
  const row = [...element.querySelectorAll("[data-message-id]")].find(
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
