// Errors that mean the whole tmux server is gone, not one session or pane.
const SERVER_GONE = /no server running|failed to connect|error connecting|no such file/i;

export function tmuxServerGone(message) {
  return SERVER_GONE.test(String(message || ""));
}

/** pid alone is reused after a reboot; the start time makes the identity unique. */
export async function readTmuxServer(manager) {
  let output;
  try {
    output = await manager.tmux(["list-sessions", "-F", "#{pid}|#{start_time}"]);
  } catch (error) {
    if (tmuxServerGone(error.message)) return null;
    throw error;
  }
  const [pid, startTime] = String(output).split("\n")[0].trim().split("|");
  return /^\d+$/.test(pid) && /^\d+$/.test(startTime)
    ? { pid: Number(pid), startTime: Number(startTime) }
    : null;
}

export function sameTmuxServer(a, b) {
  return !!a && !!b && a.pid === b.pid && a.startTime === b.startTime;
}
