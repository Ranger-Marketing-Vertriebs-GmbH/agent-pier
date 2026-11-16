import { randomUUID } from "node:crypto";
import { taskStopError } from "../chat/task-control.js";

// The commands AgentPier sends into a running Claude Code session, through the bridge
// mod's long-poll (`GET /claude-mod/v1/commands`, claude-mod-socket.js). Today only
// `task.stop`. A command stays pending until the mod posts its result as a
// `command.result` event. Each loaded copy of the mod names itself on its polls (its
// instance id): a copy gets a command once, and a copy that replaced it (a reload
// mid-poll) gets it again. A "gone" answer counts as stopped only when the command
// reached two or more copies, as an earlier copy may have stopped the task; from a
// single copy it means the task had already ended. Held in memory: a server restart
// drops pending commands, and the stop that sent one answers with its timeout.
const SUPPRESS_MS = 10 * 60 * 1000;
const MAX_SUPPRESS = 64;
const MAX_INSTANCES = 16;
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
      state = {
        poll: null,
        endedAt: null,
        grace: null,
        pending: new Map(),
        hidden: [],
        // Mod copies by instance id, ranked by first poll (at most MAX_INSTANCES).
        seen: new Map(),
        ranks: 0,
        newest: 0,
      };
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
  /** The pending commands copy `instance` has not been given yet. */
  due(state, instance) {
    return [...state.pending.values()].filter((entry) => !entry.instances.has(instance));
  }
  /**
   * One long-poll of mod copy `instance` (`owner` is the authenticated launch):
   * resolves `{ commands, suppress }` at once when commands are due for this copy or
   * the copy is new here while agents are suppressed (a reloaded copy needs the list);
   * else when a command is sent, a newer poll arrives (empty, `superseded` when it
   * comes from another copy) or `holdMs` passed (empty). `closed` resolves when the
   * request's connection closed; an unanswered poll then ends. A copy older than the
   * newest one this server has seen is answered `superseded` at once and leaves the
   * open poll alone.
   */
  poll(owner, closed, instance = "") {
    const sessionId = owner.id;
    const state = this.session(sessionId);
    const wasConnected = this.connected(sessionId);
    // Copies rank by when this server first saw them: a reload makes a newer one.
    let rank = state.seen.get(instance);
    const fresh = rank === undefined;
    if (fresh) {
      rank = ++state.ranks;
      state.seen.set(instance, rank);
      // The oldest copy goes first; it was turned away when it last polled.
      if (state.seen.size > MAX_INSTANCES)
        state.seen.delete(state.seen.keys().next().value);
    }
    // A copy older than the newest one (a replaced copy back from a backoff) never
    // takes the channel from it.
    if (rank < state.newest)
      return Promise.resolve({
        commands: [],
        suppress: this.suppressed(sessionId),
        superseded: true,
      });
    state.newest = rank;
    // The open poll is this copy's own earlier one or an older copy's.
    state.poll?.answer([], state.poll.instance !== instance);
    clearTimeout(state.grace);
    return new Promise((resolve) => {
      const poll = {
        instance,
        answer: (commands, superseded = false) => {
          if (!this.end(sessionId, state, poll)) return;
          for (const entry of commands) entry.instances.add(instance);
          resolve({
            commands: commands.map((entry) => entry.command),
            suppress: this.suppressed(sessionId),
            ...(superseded ? { superseded: true } : {}),
          });
        },
      };
      state.poll = poll;
      if (!wasConnected) this.onChange(sessionId);
      const due = this.due(state, instance);
      if (due.length || (fresh && this.suppressed(sessionId).length))
        return poll.answer(due);
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
   * no mod polls, and timeout after `timeoutMs` without an answer. A stop that did
   * not happen takes its task off the suppress list.
   */
  send(sessionId, command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.connected(sessionId)) {
      this.unhide(sessionId, command?.taskId);
      return Promise.reject(taskStopError.channelDown());
    }
    const state = this.session(sessionId);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const entry = {
        command: { ...command, id },
        instances: new Set(),
        resolve,
        reject,
      };
      entry.timer = setTimeout(() => {
        state.pending.delete(id);
        this.unhide(sessionId, command.taskId);
        reject(taskStopError.timeout());
      }, timeoutMs);
      entry.timer.unref?.();
      state.pending.set(id, entry);
      if (state.poll) {
        const due = this.due(state, state.poll.instance);
        if (due.length) state.poll.answer(due);
      }
    });
  }
  /** The mod's `command.result` event for a command of this session. */
  result(sessionId, { id, ok, reason, gone }) {
    const state = this.sessions.get(sessionId);
    const entry = state?.pending.get(id);
    if (!entry) return;
    state.pending.delete(id);
    clearTimeout(entry.timer);
    // A copy that got the command after another one (a reload) finds the task gone:
    // the earlier copy may have stopped it.
    if (ok || (gone && entry.instances.size > 1)) return entry.resolve({ ok: true });
    this.unhide(sessionId, entry.command.taskId);
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
  /** A task that was not stopped must not have its own notification dropped. */
  unhide(sessionId, taskId) {
    const state = this.sessions.get(sessionId);
    if (state) state.hidden = state.hidden.filter((item) => item.id !== taskId);
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
