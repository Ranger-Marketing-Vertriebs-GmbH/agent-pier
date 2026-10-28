import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api.js";
import { liveClient } from "./live-client.js";
import { followSignal, startLiveTopic } from "./live-topic-reader.js";

const restRead = (path, signal) => api(path, "GET", undefined, signal);
const idle = { data: null, error: "", loading: false, connected: false };

/**
 * Data of a live topic (web/lib/live/live-topics.js) in the shape of useResource:
 * `{data, error, loading, connected, refresh}`. `refresh()` reads the topic's REST
 * route and resolves with the data, or null when that read failed or the tab is
 * hidden, for a caller that must await fresh data after a write.
 */
export default function useLiveTopic(topicId) {
  const [current, setCurrent] = useState(null);
  const reader = useRef(null);
  useEffect(() => {
    if (!topicId) return;
    const started = startLiveTopic({
      topicId,
      client: liveClient(),
      read: restRead,
      report: (state) => setCurrent({ topicId, ...state }),
    });
    reader.current = started;
    return () => {
      if (reader.current === started) reader.current = null;
      started.stop();
    };
  }, [topicId]);
  const refresh = useCallback(
    () => reader.current?.refresh() ?? Promise.resolve(null),
    [],
  );
  const shown =
    current?.topicId === topicId ? current : topicId ? { ...idle, loading: true } : idle;
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
