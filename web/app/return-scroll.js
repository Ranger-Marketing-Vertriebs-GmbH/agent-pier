import { useLayoutEffect } from "react";

// A cross-link's origin page gets its scroll position back when the target's back
// arrow returns to it. One slot in sessionStorage: the last left page and, once a
// back arrow marks it, a short-lived "returning" flag. Without storage the page
// simply opens at the top.
const storageKey = "agentPierReturnScroll";
const returnWindow = 10000;

function read() {
  try {
    return JSON.parse(window.sessionStorage.getItem(storageKey) || "null");
  } catch {
    return null;
  }
}

function write(value) {
  try {
    if (value) window.sessionStorage.setItem(storageKey, JSON.stringify(value));
    else window.sessionStorage.removeItem(storageKey);
  } catch {}
}

/** Called by a back arrow that returns to `path`, right before navigating there. */
export function markReturn(path) {
  const saved = read();
  if (saved?.path === path) write({ ...saved, returning: Date.now() });
}

// Applies the saved position, retrying while late content (lists loading after mount)
// still grows the page; `finish` runs once it is applied or the retries run out.
function restore(element, saved, finish) {
  let frames = 0;
  let frame;
  const step = () => {
    element.scrollTop = saved.element;
    window.scrollTo(0, saved.window);
    const done =
      Math.abs(element.scrollTop - saved.element) < 2 &&
      Math.abs(window.scrollY - saved.window) < 2;
    if (done || ++frames >= 60) finish();
    else frame = window.requestAnimationFrame(step);
  };
  frame = window.requestAnimationFrame(step);
  return () => window.cancelAnimationFrame(frame);
}

/** Remembers where `ref`'s page at `path` was scrolled and restores it on return. */
export function useReturnScroll(ref, path) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const saved = read();
    // The slot keeps its "returning" mark until the position is applied, so an effect
    // that is torn down and run again (StrictMode, a quick re-render) still restores.
    let pending =
      saved?.path === path && Date.now() - (saved.returning || 0) < returnWindow
        ? saved
        : null;
    const cancel = pending
      ? restore(element, pending, () => {
          pending = null;
          position = { element: element.scrollTop, window: window.scrollY };
        })
      : () => {};
    let position = { element: element.scrollTop, window: window.scrollY };
    const track = () => {
      if (!pending) position = { element: element.scrollTop, window: window.scrollY };
    };
    element.addEventListener("scroll", track, { passive: true });
    window.addEventListener("scroll", track, { passive: true });
    return () => {
      cancel();
      element.removeEventListener("scroll", track);
      window.removeEventListener("scroll", track);
      write(pending || { path, ...position });
    };
  }, [ref, path]);
}
