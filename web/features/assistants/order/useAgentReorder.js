import { useCallback, useEffect, useRef, useState } from "react";
import { autoScrollStep } from "../../projects/project-drag.js";
import { dropTarget, sameTarget } from "./agent-order.js";

// Drags rows of an agent list into a new order. A mouse drags the row natively (the
// sidebar's rows may also be dragged into a split view, so both share one gesture);
// a finger presses the row for a moment, then drags it. Rows carry `data-order-id`,
// `data-order-section` and `data-order-kind`; sections (or the list itself, without
// groups) carry `data-order-section`. Escape (mouse) or lifting the finger outside
// the list cancels.
export const ORDER_MIME = "application/x-agentpier-agent-order";
/** A press this long starts a touch drag (ms); moving first scrolls instead. */
export const LONG_PRESS_MS = 450;
const TOUCH_SLOP = 10;

function measure(list) {
  if (!list) return { rows: [], sections: [] };
  const box = (node) => node.getBoundingClientRect();
  const sectionNodes = list.matches("[data-order-section]")
    ? [list]
    : [...list.querySelectorAll("[data-order-section]:not([data-order-id])")];
  return {
    sections: sectionNodes.map((node) => ({
      key: node.dataset.orderSection,
      top: box(node).top,
      bottom: box(node).bottom,
    })),
    rows: [...list.querySelectorAll("[data-order-id]")].map((node) => ({
      id: node.dataset.orderId,
      section: node.dataset.orderSection,
      kind: node.dataset.orderKind,
      top: box(node).top,
      bottom: box(node).bottom,
    })),
  };
}

// The element that scrolls the list: the nearest scrolling ancestor, else the page.
function scroller(node) {
  for (let at = node?.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (/(auto|scroll)/.test(overflowY) && at.scrollHeight > at.clientHeight) return at;
  }
  return document.scrollingElement;
}

/**
 * `entries` are the shown entries `{ id, section, kind }` (agent-order.js);
 * `onDrop(id, target)` saves a drop. Returns `drag` (`{ id, target }` while a row is
 * dragged), `listProps` for the list element, `rowProps(id, entry)` for a row and
 * `dragProps(id)` for the element a mouse drags.
 */
export default function useAgentReorder({ enabled, entries, onDrop }) {
  const [drag, setDrag] = useState(null);
  const list = useRef(null);
  const state = useRef({ entries, onDrop, drag: null });
  state.current.entries = entries;
  state.current.onDrop = onDrop;
  const touch = useRef(null); // ends the current touch press or drag

  const show = useCallback((next) => {
    state.current.drag = next;
    setDrag(next);
  }, []);
  const locate = useCallback(
    (id, y) => {
      const source = state.current.entries.find((entry) => entry.id === id);
      const target = dropTarget({ source, ...measure(list.current), y });
      const current = state.current.drag;
      if (current?.id === id && sameTarget(current.target, target)) return target;
      show({ id, target });
      return target;
    },
    [show],
  );
  const finish = useCallback(
    (id, y) => {
      const target = y === null ? null : locate(id, y);
      show(null);
      if (target) state.current.onDrop(id, target);
    },
    [locate, show],
  );

  useEffect(() => () => touch.current?.(), []);
  useEffect(() => {
    if (!enabled) touch.current?.();
  }, [enabled]);

  // A finger: hold still for LONG_PRESS_MS, then drag; moving earlier scrolls.
  const touchStart = (id) => (event) => {
    if (!enabled || touch.current || event.touches.length !== 1) return;
    // A press on a row's own controls (its ⋯ menu, the team pill) is theirs.
    if (event.target.closest?.("[aria-haspopup], [data-no-order-drag]")) return;
    const origin = event.touches[0];
    let point = { x: origin.clientX, y: origin.clientY };
    let active = false;
    let frame = 0;
    const tick = () => {
      const area = scroller(list.current);
      const rect =
        area === document.scrollingElement
          ? { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
          : area.getBoundingClientRect();
      const step = autoScrollStep(point, rect);
      if (step) area.scrollTop += step;
      locate(id, point.y);
      frame = requestAnimationFrame(tick);
    };
    const timer = setTimeout(() => {
      active = true;
      navigator.vibrate?.(10);
      window.getSelection()?.removeAllRanges();
      show({ id, target: null });
      frame = requestAnimationFrame(tick);
    }, LONG_PRESS_MS);
    const move = (moved) => {
      const at = moved.touches[0];
      if (!at) return;
      point = { x: at.clientX, y: at.clientY };
      if (active) moved.preventDefault();
      else if (
        Math.hypot(point.x - origin.clientX, point.y - origin.clientY) > TOUCH_SLOP
      )
        end();
    };
    const up = (lifted) => {
      if (!active) return end();
      // No click on the row the drag ends on.
      lifted.preventDefault();
      const inside = list.current?.getBoundingClientRect();
      const over =
        inside &&
        point.x >= inside.left &&
        point.x <= inside.right &&
        point.y >= inside.top &&
        point.y <= inside.bottom;
      end();
      finish(id, over ? point.y : null);
    };
    const cancel = () => {
      end();
      if (active) show(null);
    };
    const menu = (opened) => opened.preventDefault();
    const listeners = [
      ["touchmove", move, { passive: false }],
      ["touchend", up, { passive: false }],
      ["touchcancel", cancel],
      ["contextmenu", menu],
      ["blur", cancel],
    ];
    function end() {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      for (const [type, handler, options] of listeners)
        window.removeEventListener(type, handler, options);
      touch.current = null;
    }
    for (const [type, handler, options] of listeners)
      window.addEventListener(type, handler, options);
    touch.current = () => {
      end();
      if (active) show(null);
    };
  };

  // A mouse: the native drag of the row, dropped on the list.
  const ours = (event) =>
    !!state.current.drag &&
    Array.from(event.dataTransfer?.types ?? []).includes(ORDER_MIME);
  const listProps = {
    ref: list,
    onDragOver: (event) => {
      if (!ours(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      locate(state.current.drag.id, event.clientY);
    },
    onDragLeave: (event) => {
      if (!ours(event) || list.current?.contains(event.relatedTarget)) return;
      show({ id: state.current.drag.id, target: null });
    },
    onDrop: (event) => {
      if (!ours(event)) return;
      event.preventDefault();
      finish(state.current.drag.id, event.clientY);
    },
  };
  // The row (or its wrapper): where it is, and the touch press.
  const rowProps = (id, entry) => ({
    "data-order-id": id,
    "data-order-section": entry.section,
    "data-order-kind": entry.kind,
    ...(enabled && { onTouchStart: touchStart(id) }),
  });
  // The element a mouse drags natively; `also(event)` adds to its drag (a split view).
  const dragProps = (id, also) =>
    enabled
      ? {
          draggable: true,
          onDragStart: (event) => {
            also?.(event);
            event.dataTransfer.setData(ORDER_MIME, id);
            event.dataTransfer.effectAllowed = "move";
            show({ id, target: null });
          },
          onDragEnd: () => state.current.drag && show(null),
        }
      : {};
  return { drag: enabled ? drag : null, listProps, rowProps, dragProps };
}
