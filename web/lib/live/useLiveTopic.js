import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api.js";
import { liveClient } from "./live-client.js";
import { followSignal, startLiveTopic } from "./live-topic-reader.js";
import { startVisiblePolling } from "../visible-polling.js";

const restRead = (path, signal) => api(path, "GET", undefined, signal);
const idle = { data: null, error: "", loading: false, connected: false, readAt: null };

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
 * `{data, error, loading, connected, refresh, written}`. `refresh()` reads the topic's
 * REST route and resolves with the data, or null when that read failed or the tab is
 * hidden, for a caller that must await fresh data after a write. `written()` follows
 * a write whose change the topic pushes: it reads the route only while no push can
 * come (the fallback, a refused topic). `path` replaces the topic's REST route; a
 * signal topic's data is that route, read again per `changed`.
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
  const written = useCallback(
    () => reader.current?.written() ?? Promise.resolve(null),
    [],
  );
  const shown = shownState(current, key, topicId);
  return {
    data: shown.data,
    error: shown.error,
    loading: shown.loading,
    connected: shown.connected,
    // When the server began the read behind `data` (read-stamps.js), or null.
    readAt: shown.readAt ?? null,
    refresh,
    written,
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

/**
 * A safety read for a pushed topic whose server watch may miss a change: calls
 * `refresh` every `intervalMs` while the tab is visible and at once when it is shown
 * again, never at the start (the subscription has just read). Only for a slow interval
 * (a minute or more) that the topic documents in docs/architecture.md (AGENTS.md).
 */
export function useSafetyRead(refresh, intervalMs) {
  useEffect(
    () => startVisiblePolling(() => refresh(), intervalMs, {}, { skipFirst: true }),
    [refresh, intervalMs],
  );
}
