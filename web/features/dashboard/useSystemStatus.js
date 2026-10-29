import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { startVisiblePolling } from "../../lib/visible-polling.js";
import { usableStatus } from "./system-status-format.js";

// The server samples only while a visible page watches; hidden tabs unsubscribe.
export const SYSTEM_STATUS_INTERVAL = 5000;

// The live topic that carries a status route's answer (web/lib/live/live-topics.js).
const TOPICS = Object.freeze({
  "/system-status": "system.status",
  "/system-status/details": "system.status.details",
});

function useLiveStatus(topic, enabled, usable) {
  const live = useLiveTopic(enabled && topic ? topic : null);
  const data = live.data === null ? null : usable(live.data);
  // A pushed value without the figures counts as a failed read, as an unusable answer did.
  const error =
    live.data !== null && !data ? new Error("Unusable system status") : live.error;
  return { data, error: error || null };
}

/** Polls `path` while the page is visible, for a route without a live topic. */
function usePolledStatus(path, enabled, usable) {
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

/**
 * The system status of `path`: the summary and the details follow their live topic
 * (the server samples while this page is visible), other routes (the cleanup summary)
 * are polled while visible. `usable` turns an answer into data or null.
 */
export default function useSystemStatus(path, enabled = true, usable = usableStatus) {
  const topic = TOPICS[path] || null;
  const live = useLiveStatus(topic, enabled && Boolean(topic), usable);
  const polled = usePolledStatus(path, enabled && !topic, usable);
  return topic ? live : polled;
}
