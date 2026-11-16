// The Codex tasks AgentPier can stop, as the proxy (codex-proxy.js) sees them on the
// session's app-server connection: each thread's active turn (a subagent is a thread
// of its own) and every background terminal, a `commandExecution` item with
// `source: "unifiedExecStartup"` and a `processId` that outlives its turn.
const MAX_TURNS = 64;
const MAX_TERMINALS = 100;
const MAX_COMMAND = 1000;
const MAX_ENDED = 256;
// Thread and turn ids are UUIDs; a shell entry's id is "<threadId>:<processId>".
const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PROCESS = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = new Set(["running", "completed", "failed", "stopped", "unknown"]);
const threadId = (value) => typeof value === "string" && THREAD.test(value);
const processId = (value) => typeof value === "string" && PROCESS.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0;
// How a proxy request that Codex did not answer in time fails; the driver turns it
// into the stop's timeout (codex-task-driver.js).
export const NO_ANSWER = "no answer from Codex";

/** A finished terminal's status: Codex reports a terminated one with exit code -1. */
function endStatus(exitCode) {
  if (exitCode === -1) return "stopped";
  return exitCode === 0 ? "completed" : "failed";
}

/**
 * Follows the app-server's notifications and reports `{ turns, terminals,
 * terminalMethods }` on every change. `observe(message)` takes each notification;
 * the proxy asks `activeTurn`, `turnEnd` and `terminal` before it sends a command.
 */
export function codexTaskTracker(report = () => {}, now = Date.now) {
  const turns = new Map();
  const ended = new Map();
  const terminals = new Map();
  let terminalMethods = false;
  const emit = () => {
    try {
      report({
        turns: [...turns].map(([thread, turn]) => ({ threadId: thread, turnId: turn })),
        terminals: [...terminals.values()].map((entry) => ({ ...entry })),
        terminalMethods,
      });
    } catch {
      /* Advisory: the native protocol never waits for it. */
    }
  };
  function terminal(params, item, started) {
    if (
      item?.type !== "commandExecution" ||
      item.source !== "unifiedExecStartup" ||
      !threadId(params.threadId) ||
      !processId(item.processId)
    )
      return false;
    const key = `${params.threadId}:${item.processId}`;
    const previous = terminals.get(key);
    if (!started && !previous) return false;
    const at = (started ? params.startedAtMs : params.completedAtMs) ?? now();
    const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
    terminals.delete(key);
    terminals.set(key, {
      threadId: params.threadId,
      processId: item.processId,
      command: String(item.command ?? previous?.command ?? "").slice(0, MAX_COMMAND),
      status: started ? "running" : endStatus(exitCode),
      ...(started || exitCode === undefined ? {} : { exitCode }),
      startedAt: previous?.startedAt ?? (time(at) ? at : now()),
      updatedAt: time(at) ? at : now(),
    });
    if (terminals.size > MAX_TERMINALS) {
      const done = [...terminals].find(([, entry]) => entry.status !== "running");
      terminals.delete(done ? done[0] : terminals.keys().next().value);
    }
    return true;
  }
  function observe(message) {
    const params = message?.params;
    if (!params || typeof params !== "object") return;
    let changed = false;
    if (message.method === "turn/started" && threadId(params.threadId)) {
      // A turn id the push validation (codexTasksValue) would refuse is ignored: one
      // such id would make every report invalid and cost the whole native channel.
      if (threadId(params.turn?.id) && turns.get(params.threadId) !== params.turn.id) {
        turns.delete(params.threadId);
        turns.set(params.threadId, params.turn.id);
        if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
        changed = true;
      }
    } else if (message.method === "turn/completed" && threadId(params.threadId)) {
      const turnId = params.turn?.id;
      if (typeof turnId === "string") {
        ended.set(`${params.threadId}\0${turnId}`, String(params.turn.status ?? ""));
        if (ended.size > MAX_ENDED) ended.delete(ended.keys().next().value);
        if (turns.get(params.threadId) === turnId)
          changed = turns.delete(params.threadId);
      }
    } else if (message.method === "item/started" || message.method === "item/completed")
      changed = terminal(params, params.item, message.method === "item/started");
    if (changed) emit();
  }
  /** Whether the connection may use the background terminal methods. */
  observe.setTerminalMethods = (value) => {
    if (terminalMethods === (value === true)) return;
    terminalMethods = value === true;
    emit();
  };
  observe.terminalMethods = () => terminalMethods;
  observe.activeTurn = (thread) => turns.get(thread) ?? null;
  /** How a turn of `thread` ended (Codex's turn status), if it has. */
  observe.turnEnd = (thread, turn) => ended.get(`${thread}\0${turn}`);
  observe.terminal = (thread, process) => terminals.get(`${thread}:${process}`) ?? null;
  return observe;
}

/** A `tasks` push, validated with the tracker's own bounds; throws when invalid. */
export function codexTasksValue(message) {
  const invalid = () => {
    throw Error("Invalid native push");
  };
  const { turns, terminals, terminalMethods } = message;
  if (
    !Array.isArray(turns) ||
    turns.length > MAX_TURNS ||
    !Array.isArray(terminals) ||
    terminals.length > MAX_TERMINALS ||
    typeof terminalMethods !== "boolean"
  )
    invalid();
  for (const turn of turns)
    if (!threadId(turn?.threadId) || !threadId(turn.turnId)) invalid();
  for (const entry of terminals)
    if (
      !threadId(entry?.threadId) ||
      !processId(entry.processId) ||
      typeof entry.command !== "string" ||
      entry.command.length > MAX_COMMAND ||
      !STATUSES.has(entry.status) ||
      (entry.exitCode !== undefined && !Number.isSafeInteger(entry.exitCode)) ||
      !time(entry.startedAt) ||
      !time(entry.updatedAt)
    )
      invalid();
  return {
    type: "tasks",
    turns: turns.map((turn) => ({ threadId: turn.threadId, turnId: turn.turnId })),
    terminals: terminals.map((entry) => ({
      threadId: entry.threadId,
      processId: entry.processId,
      command: entry.command,
      status: entry.status,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
    })),
    terminalMethods,
  };
}

/**
 * The commands AgentPier may send a Codex launch (native-commands.js), a closed set.
 * Each names a turn or terminal the tracker sees running, and the proxy builds the
 * request from those ids alone:
 * - `turn.interrupt { threadId, turnId }`: `turn/interrupt`. A turn that ended by
 *   itself before Codex answered is no stop.
 * - `terminal.terminate { threadId, processId }`: needs the terminal methods; Codex
 *   answers `{ terminated: false }` for a terminal that is not there (any more).
 * `proxy` is `{ request, tracker }` from createCodexProxy; `timeoutMs` bounds each
 * request (the proxy's default, 8 s, ends before the stop service's 10 s).
 */
export function codexTaskCommands({ request: send, tracker }, { timeoutMs } = {}) {
  const request = (method, params) =>
    send(method, params, timeoutMs === undefined ? {} : { timeoutMs });
  return async (name, params) => {
    const thread = params?.threadId;
    if (name === "turn.interrupt") {
      const turnId = params?.turnId;
      if (!threadId(thread) || !turnId || tracker.activeTurn(thread) !== turnId)
        throw Error("turn not running");
      await request("turn/interrupt", { threadId: thread, turnId });
      const end = tracker.turnEnd(thread, turnId);
      if (end !== undefined && end !== "interrupted") throw Error("turn not running");
      return;
    }
    if (name === "terminal.terminate") {
      const process = params?.processId;
      if (
        !threadId(thread) ||
        !processId(process) ||
        tracker.terminal(thread, process)?.status !== "running"
      )
        throw Error("terminal not running");
      if (!tracker.terminalMethods()) throw Error("terminal methods unavailable");
      const result = await request("thread/backgroundTerminals/terminate", {
        threadId: thread,
        processId: process,
      });
      if (result?.terminated !== true) throw Error("terminal not running");
      return;
    }
    throw Error("unknown command");
  };
}
