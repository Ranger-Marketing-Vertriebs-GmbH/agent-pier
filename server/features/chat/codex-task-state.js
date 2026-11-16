import { timestamp } from "./observability-values.js";

// Threads per session whose turn the proxy reported at least once.
const MAX_THREADS = 256;

/**
 * What each Codex launch's proxy last reported it can stop (`tasks` push,
 * codex-tasks.js): the active turn per thread and every background terminal it saw.
 * Live state only, never persisted: a launch whose channel went away is forgotten,
 * and its proxy reports again when it reconnects.
 */
export class CodexTaskState {
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.sessions = new Map();
  }
  report(sessionId, push) {
    const threads = new Set(this.sessions.get(sessionId)?.threads);
    for (const { threadId } of push.turns) {
      threads.delete(threadId);
      threads.add(threadId);
    }
    while (threads.size > MAX_THREADS) threads.delete(threads.values().next().value);
    this.sessions.set(sessionId, {
      turns: new Map(push.turns.map((turn) => [turn.threadId, turn.turnId])),
      terminals: push.terminals,
      terminalMethods: push.terminalMethods === true,
      threads,
    });
    this.changed(sessionId);
  }
  /** The active turn of a thread, or null. */
  turn(sessionId, threadId) {
    return this.sessions.get(sessionId)?.turns.get(threadId) ?? null;
  }
  /** Whether the proxy has seen a turn of this thread (running now or ended since). */
  knows(sessionId, threadId) {
    return Boolean(this.sessions.get(sessionId)?.threads.has(threadId));
  }
  terminalMethods(sessionId) {
    return this.sessions.get(sessionId)?.terminalMethods === true;
  }
  /** The terminal a shell entry id ("<threadId>:<processId>") names, or null. */
  terminal(sessionId, id) {
    return (
      this.sessions
        .get(sessionId)
        ?.terminals.find((entry) => `${entry.threadId}:${entry.processId}` === id) ?? null
    );
  }
  /** The running terminals of a thread. */
  running(sessionId, threadId) {
    return (this.sessions.get(sessionId)?.terminals || []).filter(
      (entry) => entry.threadId === threadId && entry.status === "running",
    );
  }
  /** Shell entries as the chat lists them; a child thread's terminal names its agent. */
  shells(sessionId, providerSessionId) {
    return (this.sessions.get(sessionId)?.terminals || []).map((entry) => ({
      id: `${entry.threadId}:${entry.processId}`,
      command: entry.command,
      status: entry.status,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      startedAt: timestamp(entry.startedAt),
      updatedAt: timestamp(entry.updatedAt),
      ...(providerSessionId && entry.threadId !== providerSessionId
        ? { ownerAgentId: entry.threadId }
        : {}),
    }));
  }
  forget(sessionId) {
    if (this.sessions.delete(sessionId)) this.changed(sessionId);
  }
  changed(sessionId) {
    try {
      this.onChange(sessionId);
    } catch {
      /* Advisory: the next chat read still sees the state. */
    }
  }
}
