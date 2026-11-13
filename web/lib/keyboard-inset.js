// The on-screen keyboard, app-wide. iOS Safari (and Chrome on Android by default) do
// not shrink the layout viewport for the keyboard: only `window.visualViewport` does,
// so anything fixed to the bottom edge, such as a bottom sheet, ends up behind it.
// installKeyboardInset() follows the visual viewport and, while it leaves the bottom
// of the layout viewport covered, publishes on the document root:
//   --keyboard-inset          height of the covered bottom strip
//   --visual-viewport-top     top of the visible area in the layout viewport
//   --visual-viewport-height  height of the visible area
//   data-keyboard-open        set while the variables are
// Dialogs and sheets lift themselves above the keyboard with these (forms.css,
// side-panel.css); inside a dialog the bottom safe area (--safe-area-inset-bottom) is
// 0 meanwhile, since the home indicator sits behind the keyboard (base.css). A text field focused in an open
// dialog is scrolled into the visible part of it when the keyboard opens or another
// field takes focus. See docs/ui-guide.md#mobile-and-touch.

// A smaller difference is rounding or browser chrome, not a keyboard. iPadOS shows an
// accessory bar of about 55px with a hardware keyboard, which still counts.
export const minimumInset = 24;
const names = ["--keyboard-inset", "--visual-viewport-top", "--visual-viewport-height"];
// About a second of frames, as in useSessionViewport.js.
const settleFrames = 60;

/**
 * The visible area while something (the keyboard) covers the bottom of the layout
 * viewport, or null. Pinch zoom also shrinks the visual viewport; it is left alone.
 */
export function coveredViewport({ layoutHeight, height, offsetTop, scale = 1 }) {
  if (![layoutHeight, height, offsetTop, scale].every(Number.isFinite)) return null;
  if (height <= 0 || scale > 1.01) return null;
  const top = Math.max(0, offsetTop);
  const inset = layoutHeight - height - top;
  return inset >= minimumInset ? { inset, top, height } : null;
}

/**
 * How far a scroll container must scroll so that a target (top and bottom edge) lies
 * within its visible range: positive scrolls down. A target taller than the range
 * shows its top, so a search field stays visible above its results.
 */
export function revealOffset(target, view) {
  if (target.bottom > view.bottom)
    return Math.min(target.bottom - view.bottom, target.top - view.top);
  if (target.top < view.top) return target.top - view.top;
  return 0;
}

const notTyped = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function typingField(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element.tagName === "TEXTAREA") return true;
  return element.tagName === "INPUT" && !notTyped.has(element.type);
}

function scrolls(element) {
  const overflow = getComputedStyle(element).overflowY;
  return (
    (overflow === "auto" || overflow === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

// Scrolls each scroll container from the field up to its dialog, so that the field, or
// the `[data-keyboard-reveal]` block around it (a search with its results), is inside
// the container's visible part above the keyboard and clear of sticky bars (the
// container's scroll-padding).
function revealFocusedField(document, viewport) {
  const field = document.activeElement;
  const dialog = typingField(field) ? field.closest("dialog[open]") : null;
  if (!dialog) return;
  const target = field.closest("[data-keyboard-reveal]") || field;
  const visibleTop = viewport.offsetTop;
  const visibleBottom = viewport.offsetTop + viewport.height;
  for (let element = target.parentElement; element; element = element.parentElement) {
    if (scrolls(element)) {
      const box = element.getBoundingClientRect(),
        style = getComputedStyle(element);
      const view = {
        top: Math.max(box.top, visibleTop) + (parseFloat(style.scrollPaddingTop) || 0),
        bottom:
          Math.min(box.bottom, visibleBottom) -
          (parseFloat(style.scrollPaddingBottom) || 0),
      };
      const offset = revealOffset(target.getBoundingClientRect(), view);
      if (offset) element.scrollTop += offset;
    }
    if (element === dialog) break;
  }
}

/** Starts following the keyboard; returns a function that stops it. */
export function installKeyboardInset(win = window) {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const document = win.document;
  const root = document.documentElement;
  let current = null,
    frame = 0;
  const revealLater = () => {
    if (!current) return;
    win.cancelAnimationFrame(frame);
    // After the next layout, once the sheet has moved to its new place.
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      revealFocusedField(document, viewport);
    });
  };
  const update = () => {
    const next = coveredViewport({
      layoutHeight: win.innerHeight,
      height: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale,
    });
    const resized = Math.abs((next?.height ?? 0) - (current?.height ?? 0)) > 1;
    if (!next && !current) return;
    current = next;
    if (!next) {
      for (const name of names) root.style.removeProperty(name);
      root.removeAttribute("data-keyboard-open");
      return;
    }
    root.style.setProperty("--keyboard-inset", `${next.inset}px`);
    root.style.setProperty("--visual-viewport-top", `${next.top}px`);
    root.style.setProperty("--visual-viewport-height", `${next.height}px`);
    root.setAttribute("data-keyboard-open", "");
    // Only when the keyboard opens or changes height: panning alone (the visible
    // area moving while the user scrolls) must not pull the field back.
    if (resized) revealLater();
  };
  // iOS closes the keyboard while the app is in the background and, back in front,
  // reports the old visual viewport for a moment without a resize event once the
  // real one arrives: read it again on the next frames (as useSessionViewport.js).
  let settling = 0,
    frames = 0;
  const settle = () => {
    win.cancelAnimationFrame(settling);
    frames = settleFrames;
    const next = () => {
      update();
      settling = --frames > 0 ? win.requestAnimationFrame(next) : 0;
    };
    next();
  };
  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  win.addEventListener("resize", update);
  win.addEventListener("pageshow", settle);
  win.addEventListener("focus", settle);
  document.addEventListener("visibilitychange", settle);
  document.addEventListener("focusin", revealLater);
  return () => {
    win.cancelAnimationFrame(frame);
    win.cancelAnimationFrame(settling);
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    win.removeEventListener("resize", update);
    win.removeEventListener("pageshow", settle);
    win.removeEventListener("focus", settle);
    document.removeEventListener("visibilitychange", settle);
    document.removeEventListener("focusin", revealLater);
    for (const name of names) root.style.removeProperty(name);
    root.removeAttribute("data-keyboard-open");
  };
}
