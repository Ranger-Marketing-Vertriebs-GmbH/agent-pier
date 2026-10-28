import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api.js";
import { liveClient } from "./live-client.js";
import { followSignal, startLiveTopic } from "./live-topic-reader.js";

const restRead = (path, signal) => api(path, "GET", undefined, signal);
const idle = { data: null, error: "", loading: false, connected: false };

/**
 * The hook's state updater when the subscription of `key` ends: what it held is
 * dropped, so a later subscription to the same topic starts from loading and never
 * shows the previous subscription's value (an earlier job's end, say).
 */
export const releaseHeld = (key) => (held) => (held?.key === key ? null : held);

/** What the hook shows of `current` (`{key, ...state}`) for `key` and `topicId`. */
export const shownState = (current, key, topicId) =>
  current?.key === key ? current : topicId ? { ...idle, loading: true } : idle;

/**
 * Data of a live topic (web/lib/live/live-topics.js) in the shape of useResource:
 * `{data, error, loading, connected, refresh}`. `refresh()` reads the topic's REST
 * route and resolves with the data, or null when that read failed or the tab is
 * hidden, for a caller that must await fresh data after a write. `path` replaces the
 * topic's REST route; a signal topic's data is that route, read again per `changed`.
 * A topic followed again (null, then the same id) starts from loading, never from
 * what the previous subscription held.
 */
export default function useLiveTopic(topicId, path) {
  const [current, setCurrent] = useState(null);
  const reader = useRef(null);
  const key = topicId ? JSON.stringify([topicId, path || ""]) : "";
  useEffect(() => {
    if (!topicId) return;
    const started = startLiveTopic({
      topicId,
      path,
      client: liveClient(),
      read: restRead,
      report: (state) => setCurrent({ key, ...state }),
    });
    reader.current = started;
    return () => {
      if (reader.current === started) reader.current = null;
      started.stop();
      setCurrent(releaseHeld(key));
    };
  }, [topicId, path, key]);
  const refresh = useCallback(
    () => reader.current?.refresh() ?? Promise.resolve(null),
    [],
  );
  const shown = shownState(current, key, topicId);
  return {
    data: shown.data,
    error: shown.error,
    loading: shown.loading,
    connected: shown.connected,
    refresh,
  };
}

/** A counter that rises with each `changed` frame of `topicId`, to key refetches on. */
export function useLiveSignal(topicId) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!topicId) return;
    return followSignal(liveClient(), topicId, () => setCount((value) => value + 1));
  }, [topicId]);
  return count;
}
