import { useEffect, useReducer, useRef } from "react";
import { presentSubagents, SUBAGENT_FADE_MS } from "./subagent-presentation.js";

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Listed subagents of one session view. Finished agents linger and fade out on
 * client time, so the view re-renders on its own when the next change is due.
 * With reduced motion they leave without a fade.
 */
export default function useSubagentPresence(subagents, live, scope) {
  const memory = useRef(null);
  if (memory.current?.scope !== scope) memory.current = { scope, seen: new Map() };
  const [ticks, tick] = useReducer((value) => value + 1, 0);
  const result = presentSubagents(memory.current.seen, subagents, live, Date.now(), {
    fade: reducedMotion() ? 0 : SUBAGENT_FADE_MS,
  });
  useEffect(() => {
    if (result.next === null) return;
    // Each tick re-arms the timer, so one that fires early never strands an entry.
    const timer = setTimeout(tick, Math.max(0, result.next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [result.next, ticks]);
  return result.subagents;
}
