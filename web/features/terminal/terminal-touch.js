// tmux scrolls five lines per wheel report in its default copy-mode bindings. A
// report every three lines of finger travel scrolls faster than the finger, which
// feels closer to native flick scrolling than an exact match.
const fingerLinesPerReport = 3;

// xterm registers no touch handling, and under tmux its own buffer holds no history,
// so a swipe falls through to the page and triggers pull-to-refresh. Replay vertical
// swipes as wheel events: xterm already turns those into mouse reports for tmux.
export function attachTouchScroll(element, lineHeight) {
  let last = null;
  let pending = 0;
  const start = (event) => {
    last = event.touches.length === 1 ? event.touches[0] : null;
    pending = 0;
  };
  const move = (event) => {
    // Two fingers stay with the browser for pinch zoom.
    if (!last || event.touches.length !== 1) return;
    event.preventDefault();
    const touch = event.touches[0];
    const deltaX = touch.clientX - last.clientX;
    const deltaY = touch.clientY - last.clientY;
    last = touch;
    if (Math.abs(deltaY) <= Math.abs(deltaX)) return;
    // xterm sends one report per wheel event, whatever its size, so the distance
    // between events sets the scroll speed.
    pending += deltaY;
    const step = fingerLinesPerReport * lineHeight();
    while (Math.abs(pending) >= step) {
      const direction = Math.sign(pending);
      pending -= direction * step;
      event.target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: touch.clientX,
          clientY: touch.clientY,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          // Moving the finger down reveals earlier output, like a wheel turned up.
          deltaY: -direction,
        }),
      );
    }
  };
  const end = () => {
    last = null;
  };
  element.addEventListener("touchstart", start, { passive: true });
  element.addEventListener("touchmove", move, { passive: false });
  element.addEventListener("touchend", end);
  element.addEventListener("touchcancel", end);
  return () => {
    element.removeEventListener("touchstart", start);
    element.removeEventListener("touchmove", move);
    element.removeEventListener("touchend", end);
    element.removeEventListener("touchcancel", end);
  };
}
