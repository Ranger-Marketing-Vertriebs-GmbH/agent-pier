import React, { useEffect, useRef } from "react";

const buttonNames = ["left", "middle", "right"];
// Keys the page needs as key events; characters arrive as text instead.
const keys = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const modifierBits = (event) =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);
const clamp = (value) => Math.min(1, Math.max(0, value));

/**
 * The agent browser's picture; while the owner holds control it takes the owner's
 * pointer, wheel, keys, text and paste and sends them as input commands with
 * coordinates as fractions of the picture (browser-input.js maps them to the page).
 * A hidden text field takes the keyboard, so phones show theirs and IME composition
 * arrives as finished text; pinch zoom is off on the picture.
 */
export default function BrowserScreen({ image, alt, controlling, input }) {
  const picture = useRef(null);
  const field = useRef(null);
  const lastMove = useRef(0);
  const lastClick = useRef({ at: 0, x: 0, y: 0, count: 0 });
  const position = (event) => {
    const box = picture.current.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width),
      y: clamp((event.clientY - box.top) / box.height),
    };
  };
  // The wheel must be cancelable, which React's passive listener is not.
  useEffect(() => {
    const element = picture.current;
    if (!element || !controlling) return undefined;
    const wheel = (event) => {
      event.preventDefault();
      input({
        type: "wheel",
        ...position(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        modifiers: modifierBits(event),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [controlling, input, image]);
  if (!controlling) return <img src={image} alt={alt} />;
  const pointer = (action) => (event) => {
    event.preventDefault();
    const at = position(event);
    const now = Date.now();
    if (action === "move") {
      // At most about 30 moves a second.
      if (now - lastMove.current < 33) return;
      lastMove.current = now;
    }
    let clickCount = 0;
    if (action === "down") {
      field.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const previous = lastClick.current;
      const near =
        Math.abs(previous.x - at.x) < 0.01 && Math.abs(previous.y - at.y) < 0.01;
      clickCount = near && now - previous.at < 400 ? Math.min(3, previous.count + 1) : 1;
      lastClick.current = { at: now, ...at, count: clickCount };
    } else if (action === "up") clickCount = lastClick.current.count || 1;
    input({
      type: "pointer",
      action,
      ...at,
      button: action === "move" ? "none" : buttonNames[event.button] || "left",
      buttons: event.buttons & 7,
      clickCount,
      modifiers: modifierBits(event),
    });
  };
  const key = (action) => (event) => {
    if (event.nativeEvent.isComposing) return;
    const shortcut = (event.ctrlKey || event.metaKey) && event.key.length === 1;
    // A paste shortcut leaves the paste event to bring the owner's clipboard text.
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (!keys.has(event.key) && !shortcut) return;
    event.preventDefault();
    input({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      modifiers: modifierBits(event),
    });
  };
  const typed = (event) => {
    // While composing (IME), the finished text comes with compositionend.
    if (event.nativeEvent.isComposing) return;
    const value = event.currentTarget.value;
    event.currentTarget.value = "";
    if (value) input({ type: "text", text: value });
  };
  return (
    <div className="agent-browser-control">
      <img
        ref={picture}
        src={image}
        alt={alt}
        draggable={false}
        onPointerDown={pointer("down")}
        onPointerMove={pointer("move")}
        onPointerUp={pointer("up")}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={field}
        className="agent-browser-keyboard"
        aria-label={alt}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={key("down")}
        onKeyUp={key("up")}
        onInput={typed}
        onCompositionEnd={(event) => {
          const value = event.currentTarget.value;
          event.currentTarget.value = "";
          if (value) input({ type: "text", text: value });
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain") || "";
          if (text) input({ type: "paste", text: text.slice(0, 4000) });
        }}
      />
    </div>
  );
}
