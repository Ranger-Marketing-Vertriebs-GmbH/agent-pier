import { tmuxServerGone } from "./tmux-server-identity.js";

export const PANE_STATE_FORMAT = "#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}";

/**
 * The session's status and exit code from its pane state line(s), or `null` for a
 * missing pane or server.
 */
export function paneStatus(state) {
  const [dead, code, signal] = state?.split("|") || [];
  const exit =
    dead === "1" && /^\d+$/.test(code) && Number(code) <= 255 ? Number(code) : undefined;
  // tmux 3.4 can close the PTY before waitpid supplies status or signal.
  // See https://github.com/tmux/tmux/blob/3.4/format.c (pane_dead callbacks).
  const status =
    state === null || (dead === "1" && (exit !== undefined || signal))
      ? "stopped"
      : "running";
  return { status, exit };
}

/**
 * Whether a list snapshot's pane state only confirms the stored session: nothing to
 * save, no lost child signal to reap and no interruption to clear. Anything else is
 * read again from tmux under the session's lock.
 */
export function snapshotConfirms(session, state) {
  if (state === "1||") return false;
  const { status, exit } = paneStatus(state);
  if (status !== session.status) return false;
  if (exit !== undefined && session.exitCode !== exit) return false;
  return !(status === "running" && session.interruption);
}

/**
 * One `tmux list-panes -a` for a whole session list instead of one tmux process per
 * session. Maps each tmux session name to the panes of its current window, in the
 * format and order a per-session `list-panes -t =name:` prints them. A missing server
 * is an empty map; any other failure returns `null`, so each session is read alone.
 */
export async function readPaneSnapshot(manager) {
  let output;
  try {
    output = await manager.tmux([
      "list-panes",
      "-a",
      "-F",
      `#{session_name}|#{window_active}|${PANE_STATE_FORMAT}`,
    ]);
  } catch (error) {
    return tmuxServerGone(error.message) ? new Map() : null;
  }
  const panes = new Map();
  for (const line of String(output).split("\n")) {
    const [name, active, ...state] = line.trim().split("|");
    if (!name || active !== "1" || state.length !== 3) continue;
    const previous = panes.get(name);
    panes.set(name, previous ? `${previous}\n${state.join("|")}` : state.join("|"));
  }
  return panes;
}
