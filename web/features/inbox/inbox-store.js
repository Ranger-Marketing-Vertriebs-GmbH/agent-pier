import { useSyncExternalStore } from "react";

// The inbox summary ({ instance, revision, counts }) the sidebar, the phone header and
// the inbox page share. It arrives with the polled workspace state and, while the
// inbox page is open, through its event stream and list reads. A newer revision of
// the same server process wins; a new process starts its own count.
let summary = null;
const listeners = new Set();

export function publishInboxSummary(next) {
  if (!next || !Number.isSafeInteger(next.revision) || !next.counts) return;
  if (summary && summary.instance === next.instance && next.revision <= summary.revision)
    return;
  summary = {
    instance: next.instance,
    revision: next.revision,
    counts: next.counts,
  };
  for (const listener of [...listeners]) listener();
}

export function inboxSummary() {
  return summary;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInboxSummary() {
  return useSyncExternalStore(subscribe, inboxSummary, inboxSummary);
}

/** How many items wait for the owner; 0 while unknown. */
export function useInboxCount() {
  return useInboxSummary()?.counts?.all || 0;
}
