import React, { useEffect, useRef, useState } from "react";
import { imageViewerCopy as copy } from "../lib/i18n/messages/components.js";
import { observeBuild } from "../lib/build-check.js";
import FileLink from "./FileLink.jsx";
import { clampView, pinchView, scrollView, zoomAt } from "./image-viewer-zoom.js";
import "./image-viewer.css";

const rest = { scale: 1, x: 0, y: 0 };
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const apart = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// A tap moves less than this, and a second one within this time and distance doubles it.
const tapSlop = 10;
const doubleTap = { time: 300, distance: 30 };

/**
 * An image shown full size inside the app, never by navigating to it: a standalone
 * home-screen app (iOS) has no back button to return from a navigation. Closes with
 * its button, Esc, a tap beside the image or, on touch screens, a swipe down while not
 * zoomed. It fits whole at rest, however tall. Pinches (two fingers or a trackpad),
 * ctrl + wheel and double taps zoom around the fingers or the pointer; one finger, the
 * mouse or the wheel pans a zoomed image, never past its edges. A modal dialog keeps focus inside and gives it back to the element that
 * opened it. `name` is the file name a download saves.
 */
// `opener` is the element that opened it: Safari does not focus a clicked button.
export default function ImageViewer({ src, alt, title, name, close, opener = null }) {
  const dialog = useRef(null);
  const stage = useRef(null);
  const image = useRef(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState(rest);
  const [pull, setPull] = useState(0);
  const current = useRef(rest);
  const gesture = useRef({ points: new Map(), pinch: null, pan: null, swipe: null });
  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";
  // Points relative to the stage's centre, and the view kept within bounds.
  const local = ({ x, y }) => {
    const box = stage.current.getBoundingClientRect();
    return { x: x - box.left - box.width / 2, y: y - box.top - box.height / 2 };
  };
  const show = (next) => {
    const box = stage.current.getBoundingClientRect();
    const size = {
      width: image.current?.offsetWidth || 0,
      height: image.current?.offsetHeight || 0,
    };
    current.current = clampView(next, size, box);
    setView(current.current);
  };
  useEffect(() => {
    const node = dialog.current;
    const area = stage.current;
    const back = opener || document.activeElement;
    node.showModal();
    // The stage's touch-action keeps pinches and drags from the page; these also hold
    // back Safari's own page zoom (its gesture events) wherever touch-action falls short.
    const hold = (event) => event.preventDefault();
    const wheel = (event) => {
      event.preventDefault();
      // A plain wheel or two-finger trackpad scroll pans a zoomed image.
      if (!event.ctrlKey) {
        show(scrollView(current.current, event, area.getBoundingClientRect()));
        return;
      }
      // Trackpad pinches arrive as wheel events with ctrlKey set.
      const scale = current.current.scale * Math.exp(-event.deltaY / 100);
      show(zoomAt(current.current, scale, local({ x: event.clientX, y: event.clientY })));
    };
    const gestures = ["gesturestart", "gesturechange", "gestureend"];
    area.addEventListener("touchmove", hold, { passive: false });
    area.addEventListener("wheel", wheel, { passive: false });
    for (const type of gestures) node.addEventListener(type, hold);
    return () => {
      area.removeEventListener("touchmove", hold);
      area.removeEventListener("wheel", wheel);
      for (const type of gestures) node.removeEventListener(type, hold);
      node.close();
      // Back to where the owner was, for keyboards and screen readers.
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
    // Opened once; a new image is a new viewer (keyed by its id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Each pinch or drag starts from the view and the pointers as they are now.
  const begin = (g) => {
    const points = [...g.points.values()];
    g.pinch =
      points.length === 2
        ? { from: midpoint(...points), distance: apart(...points), view: current.current }
        : null;
    g.pan = points.length === 1 ? { from: points[0], view: current.current } : null;
  };
  const down = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const g = gesture.current;
    const point = { x: event.clientX, y: event.clientY };
    try {
      // Drags keep reaching the stage when they leave it.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* A pointer the browser no longer tracks. */
    }
    g.points.set(event.pointerId, point);
    g.beside = false;
    if (g.points.size === 1) {
      g.tap = { ...point, time: event.timeStamp, beside: event.target === stage.current };
      g.swipe =
        event.pointerType === "touch" && current.current.scale === 1 ? point.y : null;
    } else {
      g.tap = null;
      g.swipe = null;
      setPull(0);
    }
    begin(g);
  };
  const move = (event) => {
    const g = gesture.current;
    if (!g.points.has(event.pointerId)) return;
    const point = { x: event.clientX, y: event.clientY };
    g.points.set(event.pointerId, point);
    if (g.tap && apart(g.tap, point) > tapSlop) g.tap = null;
    if (g.pinch && g.points.size === 2) {
      const points = [...g.points.values()];
      const { from, distance, view: start } = g.pinch;
      const factor = apart(...points) / distance;
      show(pinchView(start, local(from), local(midpoint(...points)), factor));
    } else if (g.swipe !== null) setPull(Math.max(0, point.y - g.swipe));
    else if (g.pan && current.current.scale > 1) {
      const { from, view: start } = g.pan;
      show({ ...start, x: start.x + point.x - from.x, y: start.y + point.y - from.y });
    }
  };
  const up = (event) => {
    const g = gesture.current;
    if (!g.points.delete(event.pointerId)) return;
    if (event.type === "pointercancel") g.tap = null;
    // The finger that stays after a pinch drags on from where it is.
    begin(g);
    if (g.points.size) return;
    const { tap, swipe } = g;
    g.tap = null;
    g.swipe = null;
    setPull(0);
    if (tap) {
      // The click that follows closes; a click after a drag or on the image does not.
      g.beside = tap.beside;
      if (tap.beside) return;
      const last = g.last;
      g.last = tap;
      if (!last || tap.time - last.time > doubleTap.time) return;
      if (apart(tap, last) > doubleTap.distance) return;
      g.last = null;
      show(current.current.scale > 1 ? rest : zoomAt(current.current, 2, local(tap)));
    } else if (swipe !== null && event.type === "pointerup" && event.clientY - swipe > 90)
      close();
  };
  async function share() {
    try {
      const response = observeBuild(await fetch(src, { credentials: "same-origin" }));
      const blob = await response.blob();
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    } catch {
      /* Cancelled or not possible: the download stays available. */
    }
  }
  return (
    <dialog
      className="image-viewer"
      ref={dialog}
      aria-label={copy.title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header className="image-viewer-bar">
        <span className="image-viewer-title">{title}</span>
        <FileLink className="image-viewer-action" href={src} name={name}>
          {copy.download}
        </FileLink>
        {canShare && (
          <button type="button" className="image-viewer-action" onClick={share}>
            {copy.share}
          </button>
        )}
        <button
          type="button"
          className="image-viewer-close"
          aria-label={copy.close}
          onClick={close}
        >
          ×
        </button>
      </header>
      <div
        className="image-viewer-stage"
        ref={stage}
        onClick={() => {
          if (gesture.current.beside) close();
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {failed ? (
          <p className="image-viewer-missing" role="status">
            {copy.missing}
          </p>
        ) : (
          <img
            ref={image}
            src={src}
            alt={alt}
            draggable="false"
            style={{
              transform: `translate(${view.x}px, ${view.y + pull}px) scale(${view.scale})`,
              opacity: pull ? Math.max(0.4, 1 - pull / 400) : 1,
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </dialog>
  );
}
