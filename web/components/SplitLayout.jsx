import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { componentsCopy } from "../lib/i18n/messages/components.js";
import { SPLIT_GAP as GAP, ratioBounds } from "./split-geometry.js";
import "./split-layout.css";

const STEP = 0.05;
const isSplit = (node) => node?.type === "split";
const roundRatio = (value) => Math.round(value * 1000) / 1000;

// Pixel rectangles of panes and dividers for a container of `size`; `preview` replaces
// the ratio of one split while it is dragged.
function place(layout, size, minPane, keyOf, preview) {
  const panes = [],
    dividers = [];
  const walk = (node, box, path) => {
    if (!isSplit(node)) {
      panes.push({ key: keyOf(node), leaf: node, ...box });
      return;
    }
    const row = node.dir === "row";
    const bounds = ratioBounds(node, box, minPane, GAP);
    const id = path.join("");
    const stored = preview?.id === id ? preview.ratio : node.ratio;
    const ratio = Math.min(bounds.max, Math.max(bounds.min, stored));
    const total = (row ? box.width : box.height) - GAP;
    const first = Math.max(0, total * ratio);
    const second = Math.max(0, total - first);
    dividers.push({
      id,
      path,
      row,
      ratio,
      bounds,
      total,
      x: row ? box.x + first : box.x,
      y: row ? box.y : box.y + first,
      width: row ? GAP : box.width,
      height: row ? box.height : GAP,
    });
    const boxA = row ? { ...box, width: first } : { ...box, height: first };
    const boxB = row
      ? { ...box, x: box.x + first + GAP, width: second }
      : { ...box, y: box.y + first + GAP, height: second };
    walk(node.a, boxA, [...path, "a"]);
    walk(node.b, boxB, [...path, "b"]);
  };
  walk(layout, { x: 0, y: 0, width: size.width, height: size.height }, []);
  return { panes, dividers };
}

function Divider({ divider, dragging, onRatio, onPreview }) {
  const drag = useRef(null);
  const pct = (value) => Math.round(value * 100);
  const commit = (ratio) => onRatio?.(divider.path, ratio);

  const onKeyDown = (event) => {
    const delta = { ArrowLeft: -STEP, ArrowUp: -STEP, ArrowRight: STEP, ArrowDown: STEP }[
      event.key
    ];
    if (!delta) return;
    event.preventDefault();
    const { min, max } = divider.bounds;
    const next = roundRatio(Math.min(max, Math.max(min, divider.ratio + delta)));
    if (next !== roundRatio(divider.ratio)) commit(next);
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    drag.current = {
      start: divider.row ? event.clientX : event.clientY,
      ratio: divider.ratio,
      latest: divider.ratio,
    };
    onPreview({ id: divider.id, ratio: divider.ratio });
  };
  const onPointerMove = (event) => {
    const state = drag.current;
    if (!state || divider.total <= 0) return;
    const delta = (divider.row ? event.clientX : event.clientY) - state.start;
    const { min, max } = divider.bounds;
    state.latest = Math.min(max, Math.max(min, state.ratio + delta / divider.total));
    onPreview({ id: divider.id, ratio: state.latest });
  };
  const finish = (event, apply) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onPreview(null);
    if (apply && state.latest !== state.ratio) commit(roundRatio(state.latest));
  };

  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation={divider.row ? "vertical" : "horizontal"}
      aria-valuenow={pct(divider.ratio)}
      aria-valuemin={pct(divider.bounds.min)}
      aria-valuemax={pct(divider.bounds.max)}
      aria-label={componentsCopy.splitDivider}
      tabIndex={0}
      data-dragging={dragging ? "true" : undefined}
      style={{
        left: divider.x,
        top: divider.y,
        width: divider.width,
        height: divider.height,
      }}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
    />
  );
}

/**
 * Lays a binary split tree out as absolutely positioned panes. Panes render in one
 * flat list ordered by key, so moving a leaf within the tree never remounts it.
 * `layout`: `{ type: "split", dir: "row" | "col", ratio, a, b }` or a leaf; `onSize`
 * hears the measured stage size.
 */
export default function SplitLayout({
  layout,
  keyOf,
  renderPane,
  onRatio,
  minPane = { width: 280, height: 220 },
  className = "",
  onSize,
}) {
  const root = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [preview, setPreview] = useState(null);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { panes, dividers } = useMemo(
    () => place(layout, size, minPane, keyOf, preview),
    [layout, size, minPane, keyOf, preview],
  );
  const ordered = useMemo(
    () => [...panes].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
    [panes],
  );
  const setPreviewStable = useCallback((value) => setPreview(value), []);
  useLayoutEffect(() => {
    if (size.width > 0 && size.height > 0) onSize?.(size);
  }, [size, onSize]);
  const ready = size.width > 0 && size.height > 0;

  return (
    <div ref={root} className={`split-layout ${className}`.trim()}>
      {ready &&
        ordered.map((pane) => (
          <div
            key={pane.key}
            className="split-pane"
            data-pane-key={pane.key}
            style={{ left: pane.x, top: pane.y, width: pane.width, height: pane.height }}
          >
            {renderPane(pane.leaf, { width: pane.width, height: pane.height })}
          </div>
        ))}
      {ready &&
        dividers.map((divider) => (
          <Divider
            key={divider.id || "root"}
            divider={divider}
            dragging={preview?.id === divider.id}
            onRatio={onRatio}
            onPreview={setPreviewStable}
          />
        ))}
    </div>
  );
}
