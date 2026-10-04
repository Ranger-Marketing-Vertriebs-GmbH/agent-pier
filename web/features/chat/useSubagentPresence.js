import { useEffect, useReducer, useRef } from "react";
import { presentSubagents } from "./subagent-presentation.js";

/**
 * Listed subagents of one session view. Finished agents linger and fade out on
 * client time, so the view re-renders on its own when the next change is due.
 */
export default function useSubagentPresence(subagents, live, scope) {
  const memory = useRef(null);
  if (memory.current?.scope !== scope) memory.current = { scope, seen: new Map() };
  const [, tick] = useReducer((value) => value + 1, 0);
  const result = presentSubagents(memory.current.seen, subagents, live, Date.now());
  useEffect(() => {
    if (result.next === null) return;
    const timer = setTimeout(tick, Math.max(0, result.next - Date.now()));
    return () => clearTimeout(timer);
  }, [result.next]);
  return result.subagents;
}
