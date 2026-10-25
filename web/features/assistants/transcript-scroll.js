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

// Keys that scroll a focused transcript.
const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]);
// How long a wheel turn, key press or lifted finger still explains the scroll events
// that follow it (smooth scrolling and momentum run on after the input).
const inputWindow = 600;

/**
 * Keeps `container` at its end while `stick.current` holds, also when its content
 * changes size without a render: history arriving, images, video posters, cards and
 * fonts loading late. Only the reader's own scrolling (wheel, touch, scrollbar,
 * keys) lets go of the end, and scrolling back near it holds it again; a scroll the
 * browser makes by itself (clamping, anchoring, a resize) never does. `scroll.current`
 * follows the position. Returns `stop`.
 */
export function followEnd(container, stick, scroll) {
  let height = container.clientHeight;
  // A finger on the transcript, or a mouse button held on it (its scrollbar). Touch
  // pointers are left to the touch events: their pointercancel comes mid-gesture.
  const held = { touch: false, pointer: false };
  let inputAt = -Infinity;
  const pin = () => {
    if (stick.current) container.scrollTop = container.scrollHeight;
    scroll.current = container.scrollTop;
    height = container.clientHeight;
  };
  const resized = new ResizeObserver(pin);
  const observe = () =>
    [container, ...container.children].forEach((c) => resized.observe(c));
  const added = new MutationObserver(observe);
  const input = (event) => {
    if (event.type === "keydown" && !scrollKeys.has(event.key)) return;
    inputAt = performance.now();
  };
  const press = (kind, down) => (event) => {
    if (kind === "pointer" && event.pointerType === "touch") return;
    held[kind] = down;
    inputAt = performance.now();
  };
  const scrolled = () => {
    // Resizing can emit scroll before ResizeObserver runs: that is no reader's move.
    if (container.clientHeight !== height) return;
    scroll.current = container.scrollTop;
    const end =
      container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    if (end) stick.current = true;
    else if (held.touch || held.pointer || performance.now() - inputAt < inputWindow)
      stick.current = false;
  };
  const listeners = [
    [container, "scroll", scrolled],
    [container, "wheel", input],
    [container, "keydown", input],
    [container, "touchstart", press("touch", true)],
    [container, "pointerdown", press("pointer", true)],
    [window, "touchend", press("touch", false)],
    [window, "touchcancel", press("touch", false)],
    [window, "pointerup", press("pointer", false)],
    [window, "pointercancel", press("pointer", false)],
  ];
  listeners.forEach(([target, type, listener]) =>
    target.addEventListener(type, listener, { passive: true }),
  );
  observe();
  added.observe(container, { childList: true });
  pin();
  return function stop() {
    resized.disconnect();
    added.disconnect();
    listeners.forEach(([target, type, listener]) =>
      target.removeEventListener(type, listener),
    );
  };
}
