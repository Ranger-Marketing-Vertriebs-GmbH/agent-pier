import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { revealScrollLeft, scrollEdges } from "./scroll-fade.js";
import "./scroll-fade.css";

// Tracks which edges of a horizontal row hide content and reveals the active item.
export default function useScrollFade(
  ref,
  { activeSelector, revealKey, margin = 48 } = {},
) {
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const next = scrollEdges(element);
    setEdges((previous) =>
      previous.left === next.left && previous.right === next.right ? previous : next,
    );
  }, [ref]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [ref, measure]);
  // Labels and counts change the row's width without resizing it.
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = ref.current;
    const active = activeSelector && element?.querySelector(activeSelector);
    if (!active) return;
    const left = revealScrollLeft({
      itemLeft: active.offsetLeft,
      itemWidth: active.offsetWidth,
      scrollLeft: element.scrollLeft,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      margin,
    });
    if (left !== null) element.scrollLeft = left;
    measure();
  }, [ref, activeSelector, revealKey, margin, measure]);
  const scrollBy = useCallback(
    (direction) => {
      const element = ref.current;
      if (element)
        element.scrollLeft += direction * Math.max(80, element.clientWidth * 0.75);
    },
    [ref],
  );
  return { edges, scrollBy };
}
