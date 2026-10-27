import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";
import { usableStatus } from "./system-status-format.js";

// The server samples only while a page asks, so polling stops with a hidden page.
export const SYSTEM_STATUS_INTERVAL = 5000;

/** Polls `path` while the page is visible; `usable` turns an answer into data or null. */
export default function useSystemStatus(path, enabled = true, usable = usableStatus) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const stop = startVisiblePolling(async (signal) => {
      try {
        const data = usable(await api(path, "GET", undefined, signal));
        if (!data) throw new Error("Unusable system status");
        if (active) setState({ data, error: null });
      } catch (error) {
        if (active && !signal.aborted) setState((current) => ({ ...current, error }));
        throw error;
      }
    }, SYSTEM_STATUS_INTERVAL);
    return () => {
      active = false;
      stop();
    };
  }, [path, enabled, usable]);
  return state;
}
