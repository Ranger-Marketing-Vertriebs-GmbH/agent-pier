import { useEffect } from "react";
import api from "../../lib/api.js";
import { useInboxCount } from "../inbox/inbox-store.js";
import { startPresenceReporter } from "./presence-reporter.js";

/**
 * Reports the visible, focused view while push devices are registered; `base` is
 * the notification API (a user's app reports to /me/notifications).
 */
export function usePushPresence(enabled, base = "/notifications") {
  useEffect(() => {
    // Without a registered device nothing is pushed, so nothing needs reporting.
    if (!enabled) return undefined;
    return startPresenceReporter({
      send: (route) => api(`${base}/presence`, "POST", { route }).catch(() => {}),
    });
  }, [enabled, base]);
}

/** The installed app's badge shows the inbox count where the platform supports it. */
export function useAppBadge() {
  const count = useInboxCount();
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(
      () => {},
    );
  }, [count]);
}
