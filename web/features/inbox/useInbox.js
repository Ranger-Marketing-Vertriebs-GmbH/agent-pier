import { useCallback, useEffect, useRef } from "react";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { publishInboxSummary, useInboxSummary } from "./inbox-store.js";

/**
 * The inbox list from the live `inbox` topic, which pushes every change of the waiting
 * set. Without the channel, a summary revision (from the polled workspace state) that the
 * list does not hold yet reads the list again.
 */
export default function useInbox() {
  const { data, error, connected, refresh } = useLiveTopic("inbox");
  const held = useRef(null);
  held.current = data;
  useEffect(() => publishInboxSummary(data), [data]);
  // Only a list already shown can be behind; the topic's first value is on its way.
  const stale = useCallback((summary) => {
    const current = held.current;
    if (!summary || !current || !Number.isSafeInteger(summary.revision)) return false;
    return current.instance !== summary.instance || summary.revision > current.revision;
  }, []);
  const summary = useInboxSummary();
  // While the channel works, the topic pushes the newer list itself; reading it here as
  // well would send one more request per change.
  useEffect(() => {
    if (!connected && stale(summary)) refresh();
  }, [summary, connected, stale, refresh]);
  return {
    items: data?.items || [],
    counts: data?.counts || null,
    loading: !data && !error,
    error,
    reload: refresh,
  };
}
