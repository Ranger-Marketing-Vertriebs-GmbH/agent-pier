// Longer than the stop service's own 10 s, so a late answer still settles the stop.
const STOP_TIMEOUT_MS = 15000;

/**
 * The OpenCode driver of TaskControl (task-control.js): a subagent is a child session,
 * and a stop is the `session.abort` command on the native request channel, which
 * AgentPier's TUI plugin (opencode-plugin.js) runs for a child of its current session
 * only. OpenCode has no background shells. `commands` is NativeCommands
 * (native-commands.js).
 */
export function openCodeTaskDriver({ commands }) {
  return {
    connected: (session) => commands.connected(session.id),
    canStop: (session, task) => task.kind === "agent",
    stop: (session, task) =>
      commands.send(
        session.id,
        { name: "session.abort", params: { sessionId: task.id } },
        { timeoutMs: STOP_TIMEOUT_MS },
      ),
  };
}
