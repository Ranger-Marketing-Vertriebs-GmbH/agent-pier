import { useEffect, useRef, useState } from "react";

// A one-shot request for a page to open one of its own dialogs or views, e.g. the ⌘K
// action "SSH-Zugang hinzufügen" opens the SSH form on Zugänge. The search requests
// the action, then navigates; the page takes it once it is ready, whether it was
// already open or mounts afterwards. A request nobody takes expires, so a later visit
// does not open a dialog out of the blue.
const lifetime = 10_000;
const listeners = new Set();
let pending = null;
// The kinds a mounted page takes right now (usePageAction while `ready`), with a count
// per kind, so the search offers a page's own action (⌘K "Review changes") only while
// the page on screen can take it.
const offers = new Map();

export function requestPageAction(kind, now = Date.now()) {
  pending = { kind, at: now };
  for (const listener of listeners) listener(kind);
}

/** Whether `kind` is pending (and fresh); taking it clears the request. */
export function takePageAction(kind, now = Date.now()) {
  if (!pending || pending.kind !== kind) return false;
  const fresh = now - pending.at <= lifetime;
  pending = null;
  return fresh;
}

/** Marks `kind` as taken by a mounted page; the returned function ends the offer. */
export function offerPageAction(kind) {
  offers.set(kind, (offers.get(kind) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = offers.get(kind) - 1;
    if (left > 0) offers.set(kind, left);
    else offers.delete(kind);
  };
}

/** Whether a mounted page takes `kind` now. */
export const pageActionOffered = (kind) => offers.has(kind);

/**
 * Runs `run()` when `kind` is requested and `ready` is true; while `ready` the page
 * offers `kind` (pageActionOffered).
 */
export function usePageAction(kind, run, ready = true) {
  const current = useRef(run);
  useEffect(() => {
    current.current = run;
  });
  const [requests, setRequests] = useState(0);
  useEffect(() => (ready ? offerPageAction(kind) : undefined), [kind, ready]);
  useEffect(() => {
    const listener = (requested) => {
      if (requested === kind) setRequests((value) => value + 1);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, [kind]);
  useEffect(() => {
    if (ready && takePageAction(kind)) current.current();
  }, [kind, ready, requests]);
}
