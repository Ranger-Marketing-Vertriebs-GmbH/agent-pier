// Scrolls a transcript to one of its descendants with scrollTop only. scrollIntoView
// would also scroll the fixed page on iOS while the keyboard is open.
export function scrollToChild(container, element, offset = 12) {
  if (!container || !element) return false;
  const top =
    element.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop -
    offset;
  container.scrollTop = Math.max(0, top);
  return true;
}

/** The nearest ancestor that scrolls vertically (the page itself as the last resort). */
export function scrollParent(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight)
      return node;
  }
  return document.scrollingElement;
}

const readerInput = ["wheel", "touchstart", "pointerdown", "keydown"];
/**
 * Scrolls a transcript to one of its descendants and keeps it there while the content
 * still changes size (history, notes or cards that render late), until the reader
 * scrolls, touches or types in it, the element leaves, or `holds()` turns false.
 * WebKit has no scroll anchoring and would leave the element behind. Returns `stop`.
 */
export function anchorToChild(container, element, holds = () => true) {
  scrollToChild(container, element);
  const resized = new ResizeObserver(() => {
    if (element.isConnected && holds()) scrollToChild(container, element);
    else stop();
  });
  const observe = () => [...container.children].forEach((c) => resized.observe(c));
  const added = new MutationObserver(observe);
  function stop() {
    resized.disconnect();
    added.disconnect();
    readerInput.forEach((type) => container.removeEventListener(type, stop));
  }
  observe();
  added.observe(container, { childList: true });
  readerInput.forEach((type) =>
    container.addEventListener(type, stop, { passive: true }),
  );
  return stop;
}
