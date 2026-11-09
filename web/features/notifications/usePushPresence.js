import { useEffect, useRef } from "react";
import api from "../../lib/api.js";
import { liveClient } from "../../lib/live/live-client.js";
import { useInboxCount } from "../inbox/inbox-store.js";
import { startPresenceReporter } from "./presence-reporter.js";
import { applyAppBadge, watchAppBadge } from "./app-badge.js";
import { presenceRoutes } from "./presence-routes.js";

/**
 * Reports the visible, focused view while push devices are registered; `base` is
 * the notification API (a user's app reports to /me/notifications).
 */
export function usePushPresence(enabled, base = "/notifications") {
  useEffect(() => {
    // Without a registered device nothing is pushed, so nothing needs reporting.
    if (!enabled) return undefined;
    return startPresenceReporter({
      // A split view reports each visible pane; otherwise the address bar.
      routes: () => presenceRoutes() ?? [window.location.pathname],
      // The live channel carries it while open (the server scopes it to the signed-in
      // person); REST is the fallback.
      send: (route) => {
        if (liveClient().sendPresence(route)) return;
        api(`${base}/presence`, "POST", { route }).catch(() => {});
      },
    });
  }, [enabled, base]);
}

/**
 * The installed app's badge shows the inbox count where the platform supports it,
 * also after the app returns from the background with a badge a push set meanwhile.
 */
export function useAppBadge() {
  const count = useInboxCount();
  const current = useRef(count);
  current.current = count;
  useEffect(() => applyAppBadge(navigator, count), [count]);
  useEffect(
    () =>
      watchAppBadge({
        count: () => current.current,
        nav: navigator,
        doc: document,
        win: window,
      }),
    [],
  );
}
