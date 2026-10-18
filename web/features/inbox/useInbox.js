import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { publishInboxSummary, useInboxSummary } from "./inbox-store.js";

/**
 * The inbox list. Loaded once, then again whenever the event stream (or, as a
 * fallback, the polled workspace state) reports another revision, so answered or
 * expired items leave without a reload.
 */
export default function useInbox() {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  const loaded = useRef(null);
  const reading = useRef(null);
  const load = useCallback(() => {
    // One read at a time; a change during a read reads once more afterwards.
    if (reading.current) {
      reading.current.again = true;
      return reading.current.promise;
    }
    const current = { again: false };
    current.promise = (async () => {
      do {
        current.again = false;
        try {
          const next = await api("/inbox");
          loaded.current = next;
          setData(next);
          setError("");
          publishInboxSummary(next);
        } catch (e) {
          setError(e.message);
        }
      } while (current.again);
    })().finally(() => {
      reading.current = null;
    });
    reading.current = current;
    return current.promise;
  }, []);
  const stale = useCallback(
    (summary) =>
      summary &&
      (!loaded.current ||
        loaded.current.instance !== summary.instance ||
        loaded.current.revision !== summary.revision),
    [],
  );
  useEffect(() => {
    load();
    let stream,
      timer,
      attempts = 0;
    const open = () => {
      clearTimeout(timer);
      stream?.close();
      stream = new EventSource("/api/inbox/events");
      stream.onopen = () => {
        attempts = 0;
      };
      stream.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (Number.isSafeInteger(event.revision)) publishInboxSummary(event);
        if (stale(event)) load();
      };
      stream.onerror = () => {
        // 2 is EventSource.CLOSED: a refused stream is reopened with backoff.
        if (stream.readyState === 2)
          timer = setTimeout(open, Math.min(1000 * 2 ** attempts++, 30000));
      };
    };
    open();
    return () => {
      clearTimeout(timer);
      stream?.close();
    };
  }, [load, stale]);
  // The polled workspace state carries the summary too: a missed event still arrives.
  const summary = useInboxSummary();
  useEffect(() => {
    if (stale(summary)) load();
  }, [summary, stale, load]);
  return {
    items: data?.items || [],
    counts: data?.counts || null,
    loading: !data && !error,
    error,
    reload: load,
  };
}
