// Longer than the stop service's own 10 s, so a late answer still settles the stop.
const STOP_TIMEOUT_MS = 15000;
// Codex no longer has the turn or terminal: it ended by itself.
const GONE = /thread not found|turn not running|terminal not running/;

const outcome = (result) =>
  result?.ok
    ? { ok: true }
    : {
        ok: false,
        ...(GONE.test(result?.reason || "") ? { gone: true } : {}),
        ...(result?.reason ? { reason: result.reason } : {}),
      };
const gone = { ok: false, gone: true };

/**
 * The Codex driver of TaskControl (task-control.js). A subagent is a thread of its
 * own: a stop interrupts its active turn, then terminates that thread's running
 * background terminals, since an interrupted child leaves its commands running (the
 * parent is not told and its wait runs to its timeout). A shell is a background
 * terminal ("<threadId>:<processId>"), stopped only where the connection has the
 * terminal methods. Both go as commands to the launch's proxy (codex-tasks.js) over
 * NativeCommands (`commands`); `state` is CodexTaskState, which also lists the
 * shells.
 */
export function codexTaskDriver({ commands, state }) {
  const send = (session, name, params) =>
    commands.send(session.id, { name, params }, { timeoutMs: STOP_TIMEOUT_MS });
  return {
    connected: (session) => commands.connected(session.id),
    canStop: (session, task) =>
      task.kind === "agent"
        ? state.knows(session.id, task.id)
        : task.kind === "shell" && state.terminalMethods(session.id),
    shells: (session, snapshot) => state.shells(session.id, snapshot?.providerSessionId),
    async stop(session, task) {
      if (task.kind === "shell") {
        const terminal = state.terminal(session.id, task.id);
        if (terminal?.status !== "running") return gone;
        const { threadId, processId } = terminal;
        return outcome(
          await send(session, "terminal.terminate", { threadId, processId }),
        );
      }
      const turnId = state.turn(session.id, task.id);
      if (!turnId) return gone;
      const result = outcome(
        await send(session, "turn.interrupt", { threadId: task.id, turnId }),
      );
      if (!result.ok || !state.terminalMethods(session.id)) return result;
      for (const { threadId, processId } of state.running(session.id, task.id))
        // The agent is stopped; a terminal that ended meanwhile changes nothing.
        await send(session, "terminal.terminate", { threadId, processId }).catch(
          () => {},
        );
      return result;
    },
  };
}
