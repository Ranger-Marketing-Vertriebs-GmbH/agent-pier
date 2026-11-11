import React, { useId, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { componentsCopy } from "../lib/i18n/messages/components.js";
import {
  DOCKED_PANEL_STEP as STEP,
  clampWidth,
  readStoredWidth,
  storeWidth,
  widthBounds,
} from "./docked-panel-width.js";
import "./docked-panel.css";

// The parent's width, followed while it changes (window resizes, sidebar toggles).
function useParentWidth(element, enabled) {
  const [width, setWidth] = useState(null);
  useLayoutEffect(() => {
    const parent = enabled ? element.current?.parentElement : null;
    if (!parent) return undefined;
    const measure = () => setWidth(parent.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [element, enabled]);
  return width;
}

// The divider on the panel's left edge: drag, arrow keys (Home / End for the bounds),
// double-click back to the default width.
function Resizer({ width, bounds, onWidth, onCommit, onReset }) {
  const drag = useRef(null);
  const [dragging, setDragging] = useState(false);

  const onKeyDown = (event) => {
    const keys = {
      ArrowLeft: width + STEP,
      ArrowRight: width - STEP,
      Home: bounds.min,
      End: bounds.max,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = clampWidth(keys[event.key], bounds);
    if (next !== width) onCommit(next);
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus();
    drag.current = { start: event.clientX, width, latest: width };
    setDragging(true);
  };
  const onPointerMove = (event) => {
    const state = drag.current;
    if (!state) return;
    state.latest = clampWidth(state.width + state.start - event.clientX, bounds);
    onWidth(state.latest);
  };
  const finish = (event, apply) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!apply) onWidth(state.width);
    else if (state.latest !== state.width) onCommit(state.latest);
  };

  return (
    <div
      className="docked-panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-label={componentsCopy.dockedPanelResize}
      tabIndex={0}
      data-dragging={dragging ? "true" : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onDoubleClick={onReset}
    />
  );
}

/**
 * A non-modal panel docked at the right of its parent (a flex row with
 * `position: relative`), beside the page's content, which stays usable: the agent
 * chat's pinboard. On phones it covers its parent. `SidePanel` is the modal one.
 * `resizeKey` adds a divider on its left edge; the width is remembered per browser
 * under that key.
 */
export default function DockedPanel({
  title,
  subtitle,
  onClose,
  closeLabel,
  resizeKey,
  children,
}) {
  const titleId = useId();
  const panel = useRef(null);
  const resizable = Boolean(resizeKey);
  const parentWidth = useParentWidth(panel, resizable);
  const [chosen, setChosen] = useState(() =>
    resizable ? readStoredWidth(resizeKey) : null,
  );
  const bounds = widthBounds(parentWidth);
  const width = clampWidth(chosen ?? bounds.min, bounds);
  const ready = resizable && parentWidth !== null;

  const commit = (next) => {
    setChosen(next);
    storeWidth(resizeKey, next);
  };
  const reset = () => {
    setChosen(null);
    storeWidth(resizeKey, null);
  };

  return (
    <aside
      ref={panel}
      className={`docked-panel${resizable ? " resizable" : ""}`}
      aria-labelledby={titleId}
      style={ready ? { "--docked-panel-width": `${width}px` } : undefined}
    >
      {ready && (
        <Resizer
          width={width}
          bounds={bounds}
          onWidth={setChosen}
          onCommit={commit}
          onReset={reset}
        />
      )}
      <div className="docked-panel-heading">
        <div className="docked-panel-titles">
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="docked-panel-body">{children}</div>
    </aside>
  );
}
