import { useCallback, useEffect, useRef } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { publishInboxSummary, useInboxSummary } from "./inbox-store.js";

/**
 * The inbox list from the live `inbox` topic, which pushes every change of the waiting
 * set. The event stream (until it is retired) and the polled workspace state still
 * carry the summary: a revision the list does not hold yet reads the list again.
 */
export default function useInbox() {
  const { data, error, refresh } = useLiveTopic("inbox");
  const held = useRef(null);
  held.current = data;
  useEffect(() => publishInboxSummary(data), [data]);
  // Only a list already shown can be behind; the topic's first value is on its way.
  const stale = useCallback((summary) => {
    const current = held.current;
    if (!summary || !current || !Number.isSafeInteger(summary.revision)) return false;
    return current.instance !== summary.instance || summary.revision > current.revision;
  }, []);
  useEffect(() => {
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
        if (stale(event)) refresh();
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
  }, [refresh, stale]);
  const summary = useInboxSummary();
  useEffect(() => {
    if (stale(summary)) refresh();
  }, [summary, stale, refresh]);
  return {
    items: data?.items || [],
    counts: data?.counts || null,
    loading: !data && !error,
    error,
    reload: refresh,
  };
}
