import { useCallback, useSyncExternalStore } from "react";

// Whether a media query matches, kept current even where the browser misses it.
// WebKit can drop the change event when the viewport crosses a breakpoint, and during
// a resize event an existing MediaQueryList still reports the old result. So every
// resize also notifies, and every read evaluates a fresh query. useSyncExternalStore
// re-reads after subscribing, which covers a change between render and subscription.
export default function useMediaQuery(query) {
  const subscribe = useCallback(
    (notify) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", notify);
      window.addEventListener("resize", notify);
      return () => {
        media.removeEventListener("change", notify);
        window.removeEventListener("resize", notify);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
