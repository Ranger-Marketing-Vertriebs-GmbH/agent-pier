import { useEffect, useState } from "react";
import { nextDeliveryChange } from "./delivery-confirmation.js";

/**
 * The browser time for presenting `items`, re-rendering once when one of them
 * changes by time alone (the "ask" after a silent handoff, a command's brief
 * notice). A client timer: it reads nothing from the server.
 */
export default function useDeliveryClock(items) {
  const [, setTick] = useState(0);
  const now = Date.now();
  const wait = nextDeliveryChange(items, now);
  useEffect(() => {
    if (wait === null) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), wait + 50);
    return () => clearTimeout(timer);
  }, [wait]);
  return now;
}
