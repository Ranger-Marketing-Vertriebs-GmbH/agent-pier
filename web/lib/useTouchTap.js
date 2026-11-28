import { useEffect, useMemo, useRef } from "react";

// A finger that moved further was a scroll or a drag, not a tap.
const slop = 10;
// How long the browser gets to deliver its own click after the finger lifts. iOS
// sends it within a few milliseconds when it sends one at all.
export const clickWaitMs = 350;
// A click arriving this soon after the fallback acted belongs to the same tap.
const lateClickMs = 1000;

/**
 * The handlers of a button that still answers a touch tap when the browser swallows
 * its click. iOS does that next to the text cursor: while a text field has focus, a
 * tap close to the cursor goes to the system's text interaction (cursor drag, edit
 * menu), and a button right below the last line gets `pointerup` but no `click`.
 * When no click follows a tap within `clickWaitMs`, `onTap(button)` runs instead. A
 * click that does arrive is left alone, so nothing changes where clicks work.
 */
export function createTouchTap({
  onTap,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let start = null,
    timer = 0,
    acted = -Infinity;
  const cancel = () => {
    clearTimer(timer);
    timer = 0;
  };
  return {
    cancel,
    onPointerDown(event) {
      cancel();
      start =
        event.pointerType === "touch" && event.isPrimary !== false
          ? { id: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
    },
    onPointerCancel() {
      start = null;
    },
    onPointerUp(event) {
      const from = start;
      start = null;
      const button = event.currentTarget;
      if (!from || from.id !== event.pointerId || button.disabled) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > slop) return;
      const box = button.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) return;
      timer = setTimer(() => {
        timer = 0;
        // The button may have been disabled or replaced while the click was awaited.
        if (!button.isConnected || button.disabled) return;
        acted = Date.now();
        onTap(button);
      }, clickWaitMs);
    },
    onClick(event) {
      if (timer) return cancel();
      // The click came after all, but the tap was already answered.
      if (Date.now() - acted < lateClickMs) {
        acted = -Infinity;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

/** `createTouchTap` for a component: spread the result onto the button. */
export default function useTouchTap(onTap) {
  const latest = useRef(onTap);
  useEffect(() => {
    latest.current = onTap;
  });
  const tap = useMemo(() => createTouchTap({ onTap: (b) => latest.current(b) }), []);
  useEffect(() => tap.cancel, [tap]);
  const { onPointerDown, onPointerUp, onPointerCancel, onClick } = tap;
  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}

/** For a submit button: submits its form as a click on it would. */
export const submitForm = (button) => button.form?.requestSubmit(button);
