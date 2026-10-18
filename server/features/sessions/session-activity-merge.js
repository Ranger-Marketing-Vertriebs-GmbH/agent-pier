// A reported "working" turns back to the terminal reading when nothing moved for
// this long: Claude Code sends no event on Esc or a crash.
export const hookQuietMs = 15 * 1000;
export const hookStaleMs = 10 * 60 * 1000;

/**
 * Combine the CLI's own report with the terminal reading.
 * - A pending approval or question in AgentPier always means waiting.
 * - A native dialog on screen means waiting, visible native work means working.
 * - A reported state wins otherwise, until the terminal contradicts it: an idle
 *   composer with a still screen ends a reported turn (interrupt), and a report
 *   without any screen change for `staleMs` falls back to the terminal reading.
 */
export function mergeActivity({
  pane,
  hook,
  pending = false,
  now,
  paneChangedAt = 0,
  quietMs = hookQuietMs,
  staleMs = hookStaleMs,
}) {
  if (pending) return { state: "waiting", source: "request" };
  const terminal = { state: pane, source: "native-terminal" };
  if (pane === "waiting" || !hook || !["working", "idle", "waiting"].includes(hook.state))
    return terminal;
  const reported = {
    state: hook.state,
    source: "hook",
    event: hook.event,
    ...(hook.background ? { background: hook.background } : {}),
  };
  // A missed report (an older hook release) must never pass for idle while the
  // terminal clearly shows work: a reload waits for idle.
  if (hook.state === "idle") return pane === "working" ? terminal : reported;
  const quiet = now - Math.max(hook.at, paneChangedAt);
  if (hook.state === "waiting") {
    // An answered dialog leaves no event; the terminal shows the turn moving on.
    if (pane === "working" || (pane === "idle" && quiet >= quietMs)) return terminal;
    return reported;
  }
  if (quiet >= staleMs) return terminal;
  // Background tasks keep an idle composer on screen while they run.
  if (!hook.background && pane === "idle" && quiet >= quietMs) return terminal;
  return reported;
}
