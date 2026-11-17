import { taskStopError } from "./task-control.js";
import { NO_ANSWER } from "../requests/codex-tasks.js";

// Longer than the stop service's own 10 s, so a late answer still settles the stop.
const STOP_TIMEOUT_MS = 15000;
// How long a stopped agent's terminates may take before the stop answers anyway.
const TERMINATE_BOUND_MS = 1500;
// Codex no longer has the turn or terminal: it ended by itself.
const GONE = /thread not found|turn not running|terminal not running/;

/** The driver's answer to a command result; Codex not answering is the stop's timeout. */
function outcome(result) {
  if (result?.ok) return { ok: true };
  const reason = result?.reason || "";
  if (reason.endsWith(NO_ANSWER)) throw taskStopError.timeout();
  return {
    ok: false,
    ...(GONE.test(reason) ? { gone: true } : {}),
    ...(reason ? { reason } : {}),
  };
}
const gone = { ok: false, gone: true };

/**
 * The Codex driver of TaskControl (task-control.js). A subagent is a thread of its
 * own: a stop interrupts its active turn, then terminates that thread's running
 * background terminals, since an interrupted child leaves its commands running (the
 * parent is not told and its wait runs to its timeout). Those terminates run at once,
 * for at most `terminateBoundMs`, and never fail the stop: a terminal they could not
 * end stays listed running with a stop of its own. A shell is a background terminal
 * ("<threadId>:<processId>"), stopped only where the connection has the terminal
 * methods. Both go as commands to the launch's proxy (codex-tasks.js) over
 * NativeCommands (`commands`); `state` is CodexTaskState, which also lists the shells.
 */
export function codexTaskDriver({
  commands,
  state,
  terminateBoundMs = TERMINATE_BOUND_MS,
}) {
  const send = (session, name, params) =>
    commands.send(session.id, { name, params }, { timeoutMs: STOP_TIMEOUT_MS });
  const terminate = (session, { threadId, processId }) =>
    Promise.resolve()
      .then(() => send(session, "terminal.terminate", { threadId, processId }))
      .catch(() => {});
  return {
    connected: (session) => commands.connected(session.id),
    canStop: (session, task) =>
      task.kind === "agent"
        ? state.knows(session.id, task.id)
        : task.kind === "shell" && state.terminalMethods(session.id),
    shells: (session, snapshot) => state.shells(session.id, snapshot?.providerSessionId),
    // Input sent to an interrupted child starts a new turn on its thread: a turn other
    // than the one the stop interrupted (any turn, for a child a stop found ended).
    resumed(session, task, mark) {
      const turn = task.kind === "agent" && state.turn(session.id, task.id);
      if (!turn) return false;
      return mark.run ? turn !== mark.run : mark.ended === true;
    },
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
      if (result.ok) result.run = turnId;
      if (!result.ok || !state.terminalMethods(session.id)) return result;
      const terminals = state
        .running(session.id, task.id)
        .map((entry) => terminate(session, entry));
      let timer;
      await Promise.race([
        Promise.all(terminals),
        new Promise((resolve) => {
          timer = setTimeout(resolve, terminateBoundMs);
        }),
      ]);
      clearTimeout(timer);
      return result;
    },
  };
}
