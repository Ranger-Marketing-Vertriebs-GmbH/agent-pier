import React, { useEffect, useRef } from "react";
import useMobileLayout from "../../../lib/useMobileLayout.js";

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
// The hidden field keeps one invisible character, so a phone keyboard's Backspace
// always has something to delete and reports it (beforeinput deleteContentBackward).
const sentinel = "​";
// A finger that moves further than this scrolls instead of clicking.
const dragPx = 8;
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
 * arrives as finished text. On a touch screen a tap clicks and a one-finger drag
 * scrolls; pinch zoom is off on the picture. Shift+Escape leaves the browser
 * (`onEscape`); every other key goes to the page.
 * On a phone (iOS above all) the field must keep focus across taps: the keyboard opens
 * only for a focus() inside the tap itself, and the tap's own click on the picture
 * would blur the field and close it again. So the tap's touchend cancels that click
 * and focuses the field there, the field moves to the tapped point (no scroll jump),
 * and **Keyboard** (`keyboardButton`, phones only) opens it explicitly.
 */
export default function BrowserScreen({
  image,
  alt,
  controlling,
  input,
  keyboardLabel,
  keyboardButton,
  onEscape,
}) {
  const phone = useMobileLayout();
  const picture = useRef(null);
  const field = useRef(null);
  const lastMove = useRef(0);
  const lastClick = useRef({ at: 0, x: 0, y: 0, count: 0 });
  const touch = useRef(null);
  // Set on a finger's lift that clicked (not scrolled): its touchend focuses the field.
  const tapped = useRef(false);
  const focusField = () => field.current?.focus({ preventScroll: true });
  // The field sits where the finger tapped, so the phone neither scrolls to it nor
  // drops the keyboard for a field that is out of view.
  const placeField = (event) => {
    const element = field.current;
    const box = picture.current?.getBoundingClientRect();
    if (!element || !box) return;
    element.style.left = `${Math.max(0, Math.min(box.width - 1, event.clientX - box.left))}px`;
    element.style.top = `${Math.max(0, Math.min(box.height - 1, event.clientY - box.top))}px`;
  };
  const position = (event) => {
    const box = picture.current.getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width),
      y: clamp((event.clientY - box.top) / box.height),
    };
  };
  // Picture pixels per screen pixel, so a finger's drag scrolls the page as far.
  const scale = () => {
    const element = picture.current;
    const box = element.getBoundingClientRect();
    return element.naturalWidth && box.width ? element.naturalWidth / box.width : 1;
  };
  // The wheel must be cancelable, which React's passive listener is not; a phone
  // keyboard's Backspace and Enter arrive as beforeinput.
  useEffect(() => {
    const element = picture.current;
    const keyboard = field.current;
    if (!element || !keyboard || !controlling) return undefined;
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
    const beforeInput = (event) => {
      const key =
        event.inputType === "deleteContentBackward"
          ? ["Backspace", "Backspace"]
          : ["insertLineBreak", "insertParagraph"].includes(event.inputType)
            ? ["Enter", "Enter"]
            : null;
      if (!key) return;
      event.preventDefault();
      for (const action of ["down", "up"])
        input({ type: "key", action, key: key[0], code: key[1], modifiers: 0 });
    };
    // A finger's lift: its default (the emulated click on the picture) would take the
    // focus from the field and close a phone's keyboard; a tap focuses it here, inside
    // the gesture, which is when iOS opens the keyboard.
    const touchEnd = (event) => {
      if (event.cancelable) event.preventDefault();
      if (tapped.current) {
        tapped.current = false;
        keyboard.focus({ preventScroll: true });
      }
    };
    if (!keyboard.value) keyboard.value = sentinel;
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("touchend", touchEnd, { passive: false });
    keyboard.addEventListener("beforeinput", beforeInput);
    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchend", touchEnd);
      keyboard.removeEventListener("beforeinput", beforeInput);
    };
    // A new frame keeps the field as it is: resetting it would break a composition.
  }, [controlling, input]);
  if (!controlling) return <img src={image} alt={alt} />;
  const send = (action, event, at, clickCount) =>
    input({
      type: "pointer",
      action,
      ...at,
      button: action === "move" ? "none" : buttonNames[event.button] || "left",
      buttons: action === "down" ? 1 : action === "up" ? 0 : event.buttons & 7,
      clickCount,
      modifiers: modifierBits(event),
    });
  const clickCountAt = (at, now) => {
    const previous = lastClick.current;
    const near = Math.abs(previous.x - at.x) < 0.01 && Math.abs(previous.y - at.y) < 0.01;
    const count = near && now - previous.at < 400 ? Math.min(3, previous.count + 1) : 1;
    lastClick.current = { at: now, ...at, count };
    return count;
  };
  const down = (event) => {
    event.preventDefault();
    // A mouse focuses at once; a finger only once it tapped (up, touchend), so a
    // scroll does not open a phone's keyboard.
    if (event.pointerType !== "touch") focusField();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* A pointer the browser no longer tracks. */
    }
    if (event.pointerType === "touch") {
      // Decided on lift: a tap clicks, a drag scrolls.
      touch.current = { x: event.clientX, y: event.clientY, scrolled: false };
      return;
    }
    const at = position(event);
    send("down", event, at, clickCountAt(at, Date.now()));
  };
  const move = (event) => {
    event.preventDefault();
    const finger = touch.current;
    if (event.pointerType === "touch" && finger) {
      const dx = event.clientX - finger.x,
        dy = event.clientY - finger.y;
      if (!finger.scrolled && Math.hypot(dx, dy) < dragPx) return;
      finger.scrolled = true;
      finger.x = event.clientX;
      finger.y = event.clientY;
      const ratio = scale();
      input({
        type: "wheel",
        ...position(event),
        deltaX: -dx * ratio,
        deltaY: -dy * ratio,
        modifiers: 0,
      });
      return;
    }
    const now = Date.now();
    // At most about 30 moves a second.
    if (now - lastMove.current < 33) return;
    lastMove.current = now;
    send("move", event, position(event), 0);
  };
  const up = (event) => {
    event.preventDefault();
    const at = position(event);
    if (event.pointerType === "touch") {
      const finger = touch.current;
      touch.current = null;
      if (!finger || finger.scrolled) return;
      placeField(event);
      tapped.current = true;
      focusField();
      const count = clickCountAt(at, Date.now());
      send("down", event, at, count);
      send("up", event, at, count);
      return;
    }
    send("up", event, at, lastClick.current.count || 1);
  };
  const key = (action) => (event) => {
    if (event.nativeEvent.isComposing) return;
    // The way out of the browser: focus goes to the takeover bar.
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      if (action === "down") onEscape?.();
      return;
    }
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
  const flush = (element) => {
    const text = element.value.replaceAll(sentinel, "");
    element.value = sentinel;
    if (text) input({ type: "text", text });
  };
  return (
    <div className="agent-browser-control">
      <img
        ref={picture}
        src={image}
        alt={alt}
        draggable={false}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => (touch.current = null)}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={field}
        className="agent-browser-keyboard"
        aria-label={keyboardLabel}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={key("down")}
        onKeyUp={key("up")}
        onInput={(event) => {
          // While composing (IME), the finished text comes with compositionend.
          if (!event.nativeEvent.isComposing) flush(event.currentTarget);
        }}
        onCompositionEnd={(event) => flush(event.currentTarget)}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain") || "";
          if (text) input({ type: "paste", text: text.slice(0, 4000) });
        }}
      />
      {phone && keyboardButton && (
        <button
          type="button"
          className="button secondary compact agent-browser-keyboard-button"
          // Focused inside the tap, so the phone opens its keyboard.
          onClick={focusField}
        >
          {keyboardButton}
        </button>
      )}
    </div>
  );
}
