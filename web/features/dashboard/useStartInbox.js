import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { useInboxSummary } from "../inbox/inbox-store.js";

// A failed read is tried again after this long, as often as the workspace polls.
export const INBOX_RETRY_MS = 5000;

/**
 * The Inbox items for Needs you, or null while unknown. The polled workspace state
 * carries the Inbox summary; the list is read only when something waits and again
 * when the summary's revision changes, so an empty Inbox costs no request. A failed
 * read is retried until it succeeds.
 */
export default function useStartInbox() {
  const summary = useInboxSummary();
  const count = summary?.counts?.all;
  const key = summary ? `${summary.instance}:${summary.revision}` : null;
  const [items, setItems] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (key === null) return undefined;
    if (!count) {
      setItems([]);
      return undefined;
    }
    const controller = new AbortController();
    let retry;
    api("/inbox", "GET", undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          retry = setTimeout(() => setAttempt((value) => value + 1), INBOX_RETRY_MS);
      });
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [key, count, attempt]);
  return key === null ? null : items;
}
