import { useCallback, useEffect, useRef, useState } from "react";
import {
  HOVER_OPEN_MS,
  autoScrollStep,
  dropTarget,
  passedThreshold,
  sameTarget,
  sectionAt,
} from "./project-drag.js";

// The rendered sections of the list, as dropTarget() reads them.
function measureSections(scroller) {
  return [...scroller.querySelectorAll("[data-section]")].map((node) => {
    const key = node.dataset.section;
    const rect = node.getBoundingClientRect();
    return {
      key,
      groupId: key.startsWith("group:")
        ? key.slice(6)
        : key === "ungrouped"
          ? null
          : undefined,
      top: rect.top,
      bottom: rect.bottom,
      open: !node.querySelector(".project-section-rows")?.hidden,
    };
  });
}

// The click that ends a drag must not select the row or toggle the header.
function swallowNextClick() {
  const block = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", block, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", block, true), 0);
}

/**
 * Drags project rows onto sections and group headers between groups with pointer
 * events. `press(source)` returns the pointerdown handler for a row or header; a
 * press becomes a drag after a few pixels, so a plain click still works. While
 * dragging, `drag` is `{ source, target }` (see project-drag.js); the list
 * auto-scrolls near its edges and a collapsed group opens after a short hover
 * (`onOpen(key)`). Releasing over a target calls `onDrop(source, target)`; Escape
 * cancels, and releasing elsewhere does nothing.
 */
export default function useProjectDrag({ enabled, scroller, onOpen, onDrop }) {
  const [drag, setDrag] = useState(null);
  const callbacks = useRef({ onOpen, onDrop });
  callbacks.current = { onOpen, onDrop };
  const gesture = useRef(null); // ends the current press or drag

  useEffect(() => {
    if (!enabled) gesture.current?.();
  }, [enabled]);
  useEffect(() => () => gesture.current?.(), []);

  const press = useCallback(
    (source) => (event) => {
      // Touch keeps scrolling the list (a touch screen beside a mouse).
      const touch = event.pointerType === "touch";
      if (!enabled || gesture.current || touch || event.button !== 0 || !event.isPrimary)
        return;
      const element = event.currentTarget;
      const { pointerId } = event;
      const origin = { x: event.clientX, y: event.clientY };
      let point = origin;
      let phase = "pressed"; // → "dragging" → "cancelled" (Escape, until release)
      let target = null;
      let hover = null; // { key, since } of a collapsed section under the pointer
      let frame = 0;

      // The target under the pointer; shown when it changes.
      const locate = () => {
        const list = scroller.current;
        if (!list) return null;
        const rect = list.getBoundingClientRect();
        const sections = measureSections(list);
        const next = dropTarget({ source, point, list: rect, sections });
        if (!sameTarget(next, target)) {
          target = next;
          setDrag({ source, target });
        }
        return { rect, sections };
      };
      // Every frame: scroll near the edges, find the target, open a hovered group.
      const tick = (now) => {
        const list = scroller.current;
        if (!list) return;
        const step = autoScrollStep(point.y, list.getBoundingClientRect());
        if (step) list.scrollTop += step;
        const { rect, sections } = locate();
        const hit = source.type === "project" && sectionAt(sections, point.y);
        if (!hit || hit.open || point.x < rect.left || point.x > rect.right) hover = null;
        else if (hover?.key !== hit.key) hover = { key: hit.key, since: now };
        else if (now - hover.since >= HOVER_OPEN_MS) {
          hover = null;
          callbacks.current.onOpen(hit.key);
        }
        frame = requestAnimationFrame(tick);
      };
      // Ends the drag's effects; the gesture itself lasts until the button is up.
      const stop = () => {
        cancelAnimationFrame(frame);
        if (element.hasPointerCapture?.(pointerId))
          element.releasePointerCapture(pointerId);
        target = null;
        setDrag(null);
      };
      const move = (moved) => {
        if (moved.pointerId !== pointerId) return;
        point = { x: moved.clientX, y: moved.clientY };
        if (phase !== "pressed" || !passedThreshold(origin, point)) return;
        phase = "dragging";
        element.setPointerCapture?.(pointerId);
        window.getSelection()?.removeAllRanges();
        setDrag({ source, target: null });
        frame = requestAnimationFrame(tick);
      };
      const up = (released) => {
        if (released.pointerId !== pointerId) return;
        point = { x: released.clientX, y: released.clientY };
        if (phase === "dragging") locate();
        const drop = phase === "dragging" && target;
        if (phase !== "pressed") swallowNextClick();
        end();
        if (drop) callbacks.current.onDrop(source, drop);
      };
      const cancel = (cancelled) => {
        if (cancelled.pointerId === pointerId) end();
      };
      const key = (pressed) => {
        if (pressed.key !== "Escape" || phase !== "dragging") return;
        pressed.preventDefault();
        pressed.stopPropagation();
        phase = "cancelled";
        stop();
      };
      const noSelection = (started) => started.preventDefault();
      const listeners = [
        ["pointermove", move],
        ["pointerup", up],
        ["pointercancel", cancel],
        ["keydown", key, true],
        ["selectstart", noSelection],
        ["blur", end],
      ];
      function end() {
        stop();
        for (const [type, handler, capture] of listeners)
          window.removeEventListener(type, handler, capture);
        gesture.current = null;
      }
      for (const [type, handler, capture] of listeners)
        window.addEventListener(type, handler, capture);
      gesture.current = end;
    },
    [enabled, scroller],
  );

  return { drag, press: enabled ? press : null };
}
