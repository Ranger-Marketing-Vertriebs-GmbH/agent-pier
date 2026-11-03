import { useEffect } from "react";

/**
 * Keeps `--chat-scrollbar` on the element at the width of its classic scrollbar (0 for
 * overlay scrollbars and while nothing scrolls), so its padding can give that width
 * back and its content keeps the composer's column (`.chat-messages` in chat.css). A
 * scrollbar that appears or goes shrinks or grows the content box, which the observer
 * reports.
 */
export default function useScrollbarWidth(ref) {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    let last = null;
    const measure = () => {
      const width = Math.max(0, element.offsetWidth - element.clientWidth);
      if (width === last) return;
      last = width;
      element.style.setProperty("--chat-scrollbar", `${width}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [ref]);
}
