import { useEffect, useRef } from "react";

// A drag past this distance, or past this share of the sheet's height (whichever is
// shorter), dismisses the sheet on release; so does a fast downward flick.
export const DISMISS_DISTANCE = 120;
export const DISMISS_SHARE = 0.3;
export const FLICK_VELOCITY = 0.5; // px per ms
const FLICK_MIN_OFFSET = 16;
const VELOCITY_WINDOW = 100; // ms of samples the release velocity is measured over
const SLOP = 6; // px a body touch moves before it counts as a sheet drag or a scroll
const DURATION = 180; // ms
const RESIST = 60; // px a sheet that cannot close stretches at most

// Where a drag never starts: a tap on a control keeps working.
const controls = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "label",
  "summary",
  "[contenteditable]:not([contenteditable='false'])",
  "[role=button]",
  "[role^=menuitem]",
  "[role=option]",
  "[role=tab]",
  "[role=switch]",
  "[role=slider]",
].join(", ");

/**
 * The sheet follows the finger downward and never moves above its resting place. A
 * sheet that cannot close (`resist`) stretches like a rubber band instead, at most 60px.
 */
export function sheetDragOffset(dy, { resist = false } = {}) {
  if (dy <= 0) return 0;
  return resist ? RESIST * (1 - 1 / (1 + dy / RESIST)) : dy;
}

/** Release velocity in px/ms from `{ y, t }` samples, over the last 100 ms. */
export function sheetDragVelocity(samples) {
  if (samples.length < 2) return 0;
  const last = samples.at(-1);
  const first =
    samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW) || samples[0];
  const time = last.t - first.t;
  return time > 0 ? (last.y - first.y) / time : 0;
}

/** Whether a release at `offset` px with `velocity` px/ms dismisses the sheet. */
export function shouldDismissSheet({ offset, height, velocity }) {
  if (offset <= 0) return false;
  // A flick back up keeps the sheet open, however far it was dragged.
  if (velocity <= -FLICK_VELOCITY) return false;
  if (velocity >= FLICK_VELOCITY && offset >= FLICK_MIN_OFFSET) return true;
  return offset >= Math.min(DISMISS_DISTANCE, height * DISMISS_SHARE);
}

// The grab handle is drawn by CSS only where a dialog is a bottom sheet (phones; not
// the image viewer, task drawer, launch dialog or side panel), so the drag follows it.
function handleShown(dialog, zone) {
  const drawn = (element) => {
    const content = getComputedStyle(element, "::before").content;
    return Boolean(content) && content !== "none" && content !== "normal";
  };
  return drawn(dialog) || drawn(zone);
}

// A body drag only moves the sheet while nothing between the touch and the dialog is
// scrolled down; otherwise the touch scrolls the content as before.
function atTop(target, dialog) {
  for (let element = target; element; element = element.parentElement) {
    if (element.scrollTop > 0) return false;
    if (element === dialog) return true;
  }
  return true;
}

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Drag-to-dismiss for a dialog shown as a bottom sheet with a grab handle. A drag
 * starts on the heading (`.dialog-heading`, or a Sheet's handle and `.sheet-title`), or
 * as a downward touch on the body while its content is scrolled to the top. Dismissing
 * calls `dismiss`, the same path as Escape; with `disabled` the sheet snaps back.
 */
export default function useSheetDrag(ref, { dismiss, disabled = false }) {
  const latest = useRef({ dismiss, disabled });
  useEffect(() => {
    latest.current = { dismiss, disabled };
  });
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    let drag = null;
    // The end of a snap-back animation; a new drag cancels it.
    let settle = 0;
    // A dismiss in progress (slide out, close, slide back if a guard kept it open). No
    // drag starts meanwhile, and nothing cancels its timers but unmounting.
    let closing = false;
    const closeTimers = new Set();
    const later = (callback, delay) => {
      const id = setTimeout(() => {
        closeTimers.delete(id);
        callback();
      }, delay);
      closeTimers.add(id);
    };

    const move = (offset, animate) => {
      clearTimeout(settle);
      const smooth = animate && !reducedMotion();
      dialog.style.transition = smooth ? `transform ${DURATION}ms ease-out` : "none";
      dialog.style.transform = offset ? `translateY(${offset}px)` : "";
      const finish = () => {
        dialog.style.transition = "";
      };
      if (smooth) settle = setTimeout(finish, DURATION);
      else finish();
    };

    const release = (offset, velocity) => {
      const height = dialog.offsetHeight;
      const { dismiss: close, disabled: closeDisabled } = latest.current;
      if (closeDisabled || !shouldDismissSheet({ offset, height, velocity })) {
        move(0, true);
        return;
      }
      const reduced = reducedMotion();
      closing = true;
      move(reduced ? 0 : height + 24, true);
      later(
        () => {
          close();
          // A guard (unsaved changes) may keep the dialog open: bring it back.
          later(() => {
            closing = false;
            if (dialog.isConnected && dialog.open) move(0, true);
          }, 100);
        },
        reduced ? 0 : DURATION,
      );
    };

    const start = (event) => {
      drag.mode = "drag";
      dialog.style.transition = "none";
      try {
        dialog.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone.
      }
    };

    const onPointerDown = (event) => {
      if (drag || closing || !event.isPrimary) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const zone = dialog.querySelector(
        ":scope > .dialog-heading, :scope > .sheet-title",
      );
      if (!handleShown(dialog, zone)) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(controls)) return;
      // The dialog itself is the target both on a Sheet's handle (drawn by
      // `dialog.sheet::before` above the title) and on the backdrop: only a point inside
      // the dialog's box belongs to the handle.
      if (target === dialog) {
        const box = dialog.getBoundingClientRect();
        const { clientX: x, clientY: y } = event;
        if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
      }
      const inZone =
        zone &&
        (zone.contains(target) ||
          (target === dialog && event.clientY <= zone.getBoundingClientRect().bottom));
      // Mouse drags in the body select text; only touch and pen pull the sheet there.
      if (!inZone && (event.pointerType === "mouse" || !atTop(target, dialog))) return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        mode: "pending",
        offset: 0,
        samples: [{ y: event.clientY, t: event.timeStamp }],
      };
      if (!inZone) return;
      // A mouse press on the heading would otherwise start a text selection that runs
      // into the body; WebKit then stops sending pointer events to the next drag.
      if (event.pointerType === "mouse") event.preventDefault();
      start(event);
    };

    const onPointerMove = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (drag.mode === "pending") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (dy <= Math.abs(dx)) {
          drag = null;
          return;
        }
        start(event);
      }
      clearTimeout(settle);
      drag.offset = sheetDragOffset(dy, { resist: latest.current.disabled });
      dialog.style.transform = drag.offset ? `translateY(${drag.offset}px)` : "";
      drag.samples.push({ y: event.clientY, t: event.timeStamp });
      if (drag.samples.length > 20) drag.samples.shift();
    };

    const onPointerUp = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const ended = drag;
      drag = null;
      if (ended.mode !== "drag") return;
      // A finger held still before release ends with no flick.
      ended.samples.push({ y: event.clientY, t: event.timeStamp });
      if (ended.offset > SLOP) {
        // The click that ends a real mouse drag must not reach the backdrop handler; a
        // tap with a little jitter keeps its click.
        const swallow = (click) => click.stopPropagation();
        dialog.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => dialog.removeEventListener("click", swallow, true), 0);
      }
      release(ended.offset, sheetDragVelocity(ended.samples));
    };

    // A cancelled pointer, or a capture lost without pointerup, ends the drag.
    const onPointerCancel = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      // Handing the touch's implicit capture to the dialog takes it from the child.
      if (event.type === "lostpointercapture" && event.target !== dialog) return;
      const ended = drag;
      drag = null;
      if (ended.mode === "drag") move(0, true);
    };

    // The page must not scroll or bounce under a drag. A pending body touch that heads
    // down is held as well, so the browser does not start scrolling inside the slop.
    const onTouchMove = (event) => {
      if (!drag || !event.cancelable) return;
      if (drag.mode === "drag") {
        event.preventDefault();
        return;
      }
      // Only a clearly downward start is held: a wobble before a scroll up or a sideways
      // swipe keeps native scrolling.
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      if (!touch) return;
      const dy = touch.clientY - drag.y;
      if (dy >= 3 && dy > 2 * Math.abs(touch.clientX - drag.x)) event.preventDefault();
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointermove", onPointerMove);
    dialog.addEventListener("pointerup", onPointerUp);
    dialog.addEventListener("pointercancel", onPointerCancel);
    dialog.addEventListener("lostpointercapture", onPointerCancel);
    dialog.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      clearTimeout(settle);
      closeTimers.forEach(clearTimeout);
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointermove", onPointerMove);
      dialog.removeEventListener("pointerup", onPointerUp);
      dialog.removeEventListener("pointercancel", onPointerCancel);
      dialog.removeEventListener("lostpointercapture", onPointerCancel);
      dialog.removeEventListener("touchmove", onTouchMove);
    };
  }, [ref]);
}
