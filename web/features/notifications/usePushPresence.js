import { useEffect } from "react";
import api from "../../lib/api.js";
import { useInboxCount } from "../inbox/inbox-store.js";
import { startPresenceReporter } from "./presence-reporter.js";

/** Reports the visible, focused view while push devices are registered. */
export function usePushPresence(enabled) {
  useEffect(() => {
    // Without a registered device nothing is pushed, so nothing needs reporting.
    if (!enabled) return undefined;
    return startPresenceReporter({
      send: (route) => api("/notifications/presence", "POST", { route }).catch(() => {}),
    });
  }, [enabled]);
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
