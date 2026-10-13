import { useEffect, useState } from "react";

/** A row count loaded on demand; null ("—") until it is known or when loading failed. */
export default function useCount(load, enabled, key) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    load().then(
      (value) => live && setCount(Number.isInteger(value) ? value : null),
      () => live && setCount(null),
    );
    return () => {
      live = false;
    };
    // `key` identifies what is counted; `load` is a new function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
  return enabled ? count : null;
}
