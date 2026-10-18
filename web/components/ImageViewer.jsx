import React, { useEffect, useRef, useState } from "react";
import { imageViewerCopy as copy } from "../lib/i18n/messages/components.js";
import { observeBuild } from "../lib/build-check.js";
import FileLink from "./FileLink.jsx";
import "./image-viewer.css";

const distance = (points) => {
  const [a, b] = [...points.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
};
const clamp = (value) => Math.min(4, Math.max(1, value));

/**
 * An image shown full size inside the app, never by navigating to it: a standalone
 * home-screen app (iOS) has no back button to return from a navigation. Closes with
 * its button, Esc, a tap beside the image or, on touch screens, a swipe down while not
 * zoomed; pinches (and double taps) zoom. A modal dialog keeps focus inside and gives
 * it back to the element that opened it. `name` is the file name a download saves.
 */
// `opener` is the element that opened it: Safari does not focus a clicked button.
export default function ImageViewer({ src, alt, title, name, close, opener = null }) {
  const dialog = useRef(null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState(0);
  const gesture = useRef({ points: new Map(), start: null, base: 1, swipe: null });
  const canShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";
  useEffect(() => {
    const node = dialog.current;
    const back = opener || document.activeElement;
    node.showModal();
    return () => {
      node.close();
      // Back to where the owner was, for keyboards and screen readers.
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
    // Opened once; a new image is a new viewer (keyed by its id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const down = (event) => {
    const g = gesture.current;
    g.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (g.points.size === 2) {
      g.start = distance(g.points);
      g.base = scale;
      g.swipe = null;
    } else if (g.points.size === 1 && event.pointerType === "touch" && scale === 1)
      g.swipe = event.clientY;
  };
  const move = (event) => {
    const g = gesture.current;
    if (!g.points.has(event.pointerId)) return;
    g.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (g.points.size === 2 && g.start)
      setScale(clamp((g.base * distance(g.points)) / g.start));
    else if (g.swipe !== null) setOffset(Math.max(0, event.clientY - g.swipe));
  };
  const up = (event) => {
    const g = gesture.current;
    g.points.delete(event.pointerId);
    if (g.points.size < 2) g.start = null;
    if (g.swipe !== null && !g.points.size) {
      const pulled = event.clientY - g.swipe;
      g.swipe = null;
      setOffset(0);
      if (pulled > 90) close();
    }
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
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => setScale((value) => (value > 1 ? 1 : 2))}
      >
        {failed ? (
          <p className="image-viewer-missing" role="status">
            {copy.missing}
          </p>
        ) : (
          <img
            src={src}
            alt={alt}
            draggable="false"
            style={{
              transform: `translateY(${offset}px) scale(${scale})`,
              opacity: offset ? Math.max(0.4, 1 - offset / 400) : 1,
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </dialog>
  );
}
