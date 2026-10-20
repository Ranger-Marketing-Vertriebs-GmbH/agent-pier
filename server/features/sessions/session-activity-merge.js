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
 *   The result then names the report it ended in `ends`; passed back as `endedAt`,
 *   that report stays ended until the CLI sends a newer one, so typing in the
 *   terminal after Esc cannot revive it.
 * - A report of the Claude Code bridge mod (`hook.mod`) hears every turn end, an
 *   interrupt included, so an idle composer does not end it; only `staleMs`
 *   without any report or screen change does.
 */
export function mergeActivity({
  pane,
  hook,
  pending = false,
  now,
  paneChangedAt = 0,
  endedAt,
  quietMs = hookQuietMs,
  staleMs = hookStaleMs,
}) {
  if (pending) return { state: "waiting", source: "request" };
  const terminal = { state: pane, source: "native-terminal" };
  if (!hook || !["working", "idle", "waiting"].includes(hook.state)) return terminal;
  const reported = {
    state: hook.state,
    source: hook.mod ? "mod" : "hook",
    event: hook.event,
    ...(hook.background ? { background: hook.background } : {}),
  };
  if (hook.state !== "idle" && hook.at === endedAt) return terminal;
  // Only a dialog the CLI reported itself counts as its own wait; a model picker
  // the owner opened stays a terminal reading.
  if (pane === "waiting") return hook.state === "waiting" ? reported : terminal;
  // A missed report (an older hook release) must never pass for idle while the
  // terminal clearly shows work: a reload waits for idle.
  if (hook.state === "idle") return pane === "working" ? terminal : reported;
  const quiet = now - Math.max(hook.at, paneChangedAt);
  const ended = { ...terminal, ends: hook.at };
  if (quiet >= staleMs) return ended;
  if (hook.state === "waiting") {
    // An answered dialog leaves no event; the terminal shows the turn moving on.
    if (pane === "working") return terminal;
    return pane === "idle" && quiet >= quietMs ? ended : reported;
  }
  // Background tasks keep an idle composer on screen while they run.
  if (!hook.mod && !hook.background && pane === "idle" && quiet >= quietMs) return ended;
  return reported;
}
