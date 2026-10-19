// While this page is visible and focused it tells the server which view it shows,
// so no push arrives about what the owner is looking at (the server holds pushes about
// a view seen in the last 30 seconds; server/features/notifications/push-presence.js).
// A window left open but unfocused (a desktop showing the inbox while the owner is
// away with the phone) never reports, or it would silence the phone indefinitely.
export const heartbeatMs = 15000;
export const checkMs = 1000;

/** Starts reporting; returns the function that stops it. */
export function startPresenceReporter({
  doc = document,
  win = window,
  send,
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
}) {
  let last = { route: null, at: 0 };
  let focused = doc.hasFocus();
  const attending = () => focused && doc.visibilityState === "visible" && doc.hasFocus();
  const report = () => {
    if (!attending()) return;
    const route = win.location.pathname;
    const at = now();
    if (route === last.route && at - last.at < heartbeatMs) return;
    last = { route, at };
    send(route);
  };
  // Coming back to a page counts at once; leaving it stops the reports.
  const resume = () => {
    focused = doc.hasFocus();
    last = { route: null, at: 0 };
    report();
  };
  const pause = () => {
    focused = false;
  };
  report();
  // A route change reports within a second; an unchanged view every 15 seconds.
  const timer = setTimer(report, checkMs);
  doc.addEventListener("visibilitychange", resume);
  win.addEventListener("focus", resume);
  win.addEventListener("blur", pause);
  return () => {
    clearTimer(timer);
    doc.removeEventListener("visibilitychange", resume);
    win.removeEventListener("focus", resume);
    win.removeEventListener("blur", pause);
  };
}
