import { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { useInboxSummary } from "../inbox/inbox-store.js";

/**
 * The Inbox items for Needs you, or null while unknown. The polled workspace state
 * carries the Inbox summary; the list is read only when something waits and again
 * when the summary's revision changes, so an empty Inbox costs no request.
 */
export default function useStartInbox() {
  const summary = useInboxSummary();
  const count = summary?.counts?.all;
  const key = summary ? `${summary.instance}:${summary.revision}` : null;
  const [items, setItems] = useState(null);
  useEffect(() => {
    if (key === null) return undefined;
    if (!count) {
      setItems([]);
      return undefined;
    }
    const controller = new AbortController();
    api("/inbox", "GET", undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setItems(Array.isArray(data?.items) ? data.items : []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [key, count]);
  return key === null ? null : items;
}
