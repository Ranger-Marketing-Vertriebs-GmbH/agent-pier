import { useEffect, useRef } from "react";

// A tapped push notification's page, shown in place while AgentPier is already open
// (public/sw.js openLink). The worker posts the app path it opens; the page moves there
// with its own router, so nothing reloads and unsaved work still asks first, and
// answers on the message's port. Platforms whose worker cannot navigate an open window
// (a standalone app on iPhone and iPad) depend on this answer.
export const notificationOpenType = "agentpier-open";

/** The same-origin URL of a posted app path, or null for anything else. */
export function notificationUrl(link, origin = globalThis.location?.origin) {
  if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//"))
    return null;
  try {
    const url = new URL(link, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

/**
 * Follows the worker's open messages until the returned function stops it. `open`
 * receives the URL and returns whether this app has a page for it.
 */
export function listenForNotificationOpen(
  open,
  {
    container = globalThis.navigator?.serviceWorker,
    origin = globalThis.location?.origin,
  } = {},
) {
  if (!container?.addEventListener) return () => {};
  const listener = (event) => {
    if (event.data?.type !== notificationOpenType) return;
    // Only this origin's worker posts here; a page of another origin never can.
    if (event.origin && event.origin !== origin) return;
    const url = notificationUrl(event.data.link, origin);
    let opened = false;
    try {
      opened = Boolean(url && open(url));
    } catch {
      opened = false;
    }
    event.ports?.[0]?.postMessage({ opened });
  };
  container.addEventListener("message", listener);
  // Messages sent before the page listened wait until it starts them.
  container.startMessages?.();
  return () => container.removeEventListener("message", listener);
}

/** The hook form: `open(url)` returns whether the app has a page for the URL. */
export function useNotificationOpen(open) {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => listenForNotificationOpen((url) => latest.current(url)), []);
}
