import { useEffect } from "react";
import api from "../../lib/api.js";
import { useInboxCount } from "../inbox/inbox-store.js";

// While this page is visible it tells the server which view it shows, so no push
// arrives about what the owner is already looking at (the server holds pushes about
// a view seen in the last 30 seconds; server/features/notifications/push-presence.js).
const heartbeatMs = 15000;
const checkMs = 1000;

export function usePushPresence(enabled) {
  useEffect(() => {
    // Without a registered device nothing is pushed, so nothing needs reporting.
    if (!enabled) return undefined;
    let last = { route: null, at: 0 };
    const report = () => {
      if (document.visibilityState !== "visible") return;
      const route = window.location.pathname;
      const now = Date.now();
      if (route === last.route && now - last.at < heartbeatMs) return;
      last = { route, at: now };
      api("/notifications/presence", "POST", { route }).catch(() => {});
    };
    const visible = () => {
      // Coming back to a page counts at once.
      if (document.visibilityState === "visible") last = { route: null, at: 0 };
      report();
    };
    report();
    // A route change reports within a second; an unchanged view every 15 seconds.
    const timer = setInterval(report, checkMs);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
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
