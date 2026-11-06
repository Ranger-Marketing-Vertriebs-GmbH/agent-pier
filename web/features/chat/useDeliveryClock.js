import { useEffect, useRef, useState } from "react";
import { followDeliveryClock } from "./delivery-confirmation.js";

/**
 * The browser time for presenting `items`, re-rendering at each time-based view
 * change (the "ask" after a silent handoff, a command's brief notice). A client
 * timer: it reads nothing from the server.
 */
export default function useDeliveryClock(items) {
  const [, setTick] = useState(0);
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });
  // Re-arm only when a timed field changes, not on every render.
  const timing = items
    .map((item) => [item.id, item.status, item.handedOffAt, item.acceptedAt].join(":"))
    .join(",");
  useEffect(
    () =>
      followDeliveryClock(
        () => latest.current,
        () => setTick((tick) => tick + 1),
      ),
    [timing],
  );
  return Date.now();
}
