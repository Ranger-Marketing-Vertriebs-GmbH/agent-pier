import { useCallback, useRef } from "react";

/**
 * A setter for one draft field that also accepts an updater, like useState's. Several
 * updates before the next render compose (the endpoint editors rely on that).
 */
export default function useFieldSetter(draft, key) {
  const latest = useRef(draft.values[key]);
  latest.current = draft.values[key];
  const set = draft.set;
  return useCallback(
    (update) => {
      const next = typeof update === "function" ? update(latest.current) : update;
      latest.current = next;
      set(key, next);
    },
    [key, set],
  );
}
