/** Shows `count` on the installed app's icon where the platform supports a badge. */
export function applyAppBadge(nav, count) {
  if (!nav || !("setAppBadge" in nav)) return;
  Promise.resolve()
    .then(() => (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()))
    .catch(() => {});
}

/**
 * Applies the current count again whenever the page comes back (it becomes visible,
 * or a suspended page is restored): the service worker sets the badge from a push
 * while the app is in the background (public/sw.js), and an inbox count that did not
 * change meanwhile would otherwise leave that badge standing. Returns the cleanup.
 */
export function watchAppBadge({ count, nav, doc, win }) {
  const apply = () => applyAppBadge(nav, count());
  const visible = () => {
    if (doc.visibilityState === "visible") apply();
  };
  doc.addEventListener("visibilitychange", visible);
  win.addEventListener("pageshow", apply);
  return () => {
    doc.removeEventListener("visibilitychange", visible);
    win.removeEventListener("pageshow", apply);
  };
}
