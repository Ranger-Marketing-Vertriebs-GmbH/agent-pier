import { randomUUID } from "node:crypto";
import { taskStopError } from "../chat/task-control.js";

// The commands AgentPier sends into a running Claude Code session, through the bridge
// mod's long-poll (`GET /claude-mod/v1/commands`, claude-mod-socket.js). Today only
// `task.stop`. A command stays pending until the mod posts its result as a
// `command.result` event; every poll until then carries it again, so a mod copy
// reloaded mid-poll still gets it (and its TaskStop then finds the task gone, which
// counts as stopped). Held in memory: a server restart drops pending commands, and
// the stop that sent one answers with its timeout.
const SUPPRESS_MS = 10 * 60 * 1000;
const MAX_SUPPRESS = 64;
const DEFAULT_TIMEOUT_MS = 10000;

export class ClaudeModCommands {
  /**
   * `holdMs`: how long a poll waits for a command before it is answered empty (below
   * the 30 s after which Claude Code's host aborts a `$.http.fetch`). `graceMs`: how
   * long the channel counts as connected after a poll ended, while the mod opens the
   * next one. `onChange(sessionId)` hears that the channel came up or went down.
   */
  constructor({
    holdMs = 25000,
    graceMs = 3000,
    onChange = () => {},
    now = Date.now,
  } = {}) {
    Object.assign(this, { holdMs, graceMs, onChange, now });
    this.sessions = new Map();
  }
  session(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { poll: null, endedAt: null, grace: null, pending: new Map(), hidden: [] };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
  /** Whether a poll is open, or ended less than `graceMs` ago. */
  connected(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    if (state.poll) return true;
    return state.endedAt !== null && this.now() - state.endedAt < this.graceMs;
  }
  /** Something the channel's readers depend on changed (the mod's hello). */
  changed(sessionId) {
    this.onChange(sessionId);
  }
  /**
   * One long-poll of the mod (`owner` is the authenticated launch): resolves the
   * answer `{ commands, suppress }` at once when commands are pending, else when one
   * is sent, a newer poll arrives (empty) or `holdMs` passed (empty). `closed`
   * resolves when the request's connection closed; an unanswered poll then ends.
   */
  poll(owner, closed) {
    const sessionId = owner.id;
    const state = this.session(sessionId);
    const wasConnected = this.connected(sessionId);
    state.poll?.answer([]);
    clearTimeout(state.grace);
    return new Promise((resolve) => {
      const poll = {
        answer: (commands) => {
          if (!this.end(sessionId, state, poll)) return;
          for (const entry of commands) entry.deliveries++;
          resolve({
            commands: commands.map((entry) => entry.command),
            suppress: this.suppressed(sessionId),
          });
        },
      };
      state.poll = poll;
      if (!wasConnected) this.onChange(sessionId);
      if (state.pending.size) return poll.answer([...state.pending.values()]);
      poll.timer = setTimeout(() => poll.answer([]), this.holdMs);
      poll.timer.unref?.(); // The poll's own connection keeps the server alive.
      Promise.resolve(closed).then(() => {
        if (this.end(sessionId, state, poll)) resolve(null);
      });
    });
  }
  /** End `poll` if it is still the open one; false when it already ended. */
  end(sessionId, state, poll) {
    if (state.poll !== poll) return false;
    clearTimeout(poll.timer);
    state.poll = null;
    state.endedAt = this.now();
    clearTimeout(state.grace);
    state.grace = setTimeout(() => {
      if (!state.poll && this.sessions.get(sessionId) === state) this.onChange(sessionId);
    }, this.graceMs);
    state.grace.unref?.();
    return true;
  }
  /**
   * Send `command` (`{ name, taskId }`) to the session's mod. Resolves `{ ok: true }`
   * or `{ ok: false, reason?, gone? }` once the mod answers; rejects channelDown when
   * no mod polls, and timeout after `timeoutMs` without an answer.
   */
  send(sessionId, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.connected(sessionId)) return Promise.reject(taskStopError.channelDown());
    const state = this.session(sessionId);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const entry = { command: { id, ...command }, deliveries: 0, resolve, reject };
      entry.timer = setTimeout(() => {
        state.pending.delete(id);
        reject(taskStopError.timeout());
      }, timeoutMs);
      entry.timer.unref?.();
      state.pending.set(id, entry);
      state.poll?.answer([...state.pending.values()]);
    });
  }
  /** The mod's `command.result` event for a command of this session. */
  result(sessionId, { id, ok, reason, gone }) {
    const state = this.sessions.get(sessionId);
    const entry = state?.pending.get(id);
    if (!entry) return;
    state.pending.delete(id);
    clearTimeout(entry.timer);
    // A copy that got the command again after a reload finds the task already gone:
    // the first delivery stopped it.
    if (ok || (gone && entry.deliveries > 1)) return entry.resolve({ ok: true });
    // A task that was not stopped must not have its own notification dropped.
    state.hidden = state.hidden.filter((item) => item.id !== entry.command.taskId);
    entry.resolve({
      ok: false,
      ...(reason !== undefined ? { reason } : {}),
      ...(gone ? { gone: true } : {}),
    });
  }
  /** Ask the mod to drop the notification of agent `agentId`'s stop. */
  suppress(sessionId, agentId) {
    const state = this.session(sessionId);
    this.suppressed(sessionId);
    state.hidden = state.hidden
      .filter((item) => item.id !== agentId)
      .concat({ id: agentId, at: this.now() })
      .slice(-MAX_SUPPRESS);
  }
  /** The agent ids whose stop notification the mod drops, oldest first. */
  suppressed(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    state.hidden = state.hidden.filter((item) => this.now() - item.at < SUPPRESS_MS);
    return state.hidden.map((item) => item.id);
  }
  /** A new launch or a stopped session: its open poll and pending commands end. */
  forget(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.sessions.delete(sessionId);
    state.poll?.answer([]);
    clearTimeout(state.grace);
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(taskStopError.channelDown());
    }
  }
}
