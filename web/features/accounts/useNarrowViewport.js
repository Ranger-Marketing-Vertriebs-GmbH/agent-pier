import { useSyncExternalStore } from "react";

const query = "(max-width: 700px)";
const subscribe = (notify) => {
  const list = window.matchMedia(query);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
};

/** Phones show the hub and an entry's subpage one at a time. */
export default function useNarrowViewport() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
