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

function restore(element, saved) {
  let frames = 0;
  const step = () => {
    element.scrollTop = saved.element;
    window.scrollTo(0, saved.window);
    const done =
      Math.abs(element.scrollTop - saved.element) < 2 &&
      Math.abs(window.scrollY - saved.window) < 2;
    // Late content (lists loading after mount) can still grow the page.
    if (!done && ++frames < 60) frame = window.requestAnimationFrame(step);
  };
  let frame = window.requestAnimationFrame(step);
  return () => window.cancelAnimationFrame(frame);
}

/** Remembers where `ref`'s page at `path` was scrolled and restores it on return. */
export function useReturnScroll(ref, path) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const saved = read();
    let cancel = () => {};
    if (saved?.path === path && Date.now() - (saved.returning || 0) < returnWindow) {
      write(null);
      cancel = restore(element, saved);
    }
    let position = { element: element.scrollTop, window: window.scrollY };
    const track = () => {
      position = { element: element.scrollTop, window: window.scrollY };
    };
    element.addEventListener("scroll", track, { passive: true });
    window.addEventListener("scroll", track, { passive: true });
    return () => {
      cancel();
      element.removeEventListener("scroll", track);
      window.removeEventListener("scroll", track);
      write({ path, ...position });
    };
  }, [ref, path]);
}
