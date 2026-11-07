import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Keeps the transcript's scroll position while the pinboard takes its place: the
 * transcript stays mounted but `hidden`, which drops its offset in some engines. A
 * reader who scrolled up finds the same place again; one who followed the end keeps
 * following it (useTranscriptScroll's `stick`).
 */
export default function useKeptScroll(output, stick, hidden) {
  const kept = useRef(0);
  useEffect(() => {
    const element = output.current;
    if (!element) return undefined;
    const keep = () => {
      if (element.clientHeight) kept.current = element.scrollTop;
    };
    keep();
    element.addEventListener("scroll", keep, { passive: true });
    return () => element.removeEventListener("scroll", keep);
  }, [output]);
  useLayoutEffect(() => {
    const element = output.current;
    if (hidden || !element) return;
    element.scrollTop = stick.current ? element.scrollHeight : kept.current;
  }, [hidden, output, stick]);
}
