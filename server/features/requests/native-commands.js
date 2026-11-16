import { randomUUID } from "node:crypto";
import { send as write } from "./wire.js";
import { taskStopError } from "../chat/task-control.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_REASON = 500;
const MAX_PENDING = 64;

/**
 * Commands AgentPier sends to the owner of a session's native request channel
 * (native-channel.js), each answered with a result: `{ type: "command", id, name,
 * params }` out, `{ type: "command-result", id, ok, reason?, data? }` back. A socket
 * takes commands only once the broker authenticated it as the session's owner (its
 * hello named the session and carried the launch's token) and the hello offered
 * `commands: true`. Every process holding the launch token (the CLI's shells inherit
 * it) can say such a hello, so the first commands socket of a session keeps the
 * commands while it is open: a later one with another epoch is no commands socket,
 * and only a reconnect of the same channel (same epoch) takes over. Once it closed,
 * the next commands hello joins. The server makes every command id, and only the
 * socket a command went to settles it with a result for that id.
 * Held in memory: a closed socket or a timeout ends what it had pending.
 */
export class NativeCommands {
  /** `onChange(sessionId)` hears that a session's command channel came up or went down. */
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    // The commands socket of each session.
    this.sockets = new Map();
    this.pending = new Map();
  }
  /** An authenticated owner socket said hello. */
  joined(socket, hello) {
    if (hello?.commands !== true || !socket.owner) return;
    const id = socket.owner.id;
    const current = this.sockets.get(id);
    if (
      current &&
      current !== socket &&
      !current.destroyed &&
      current.owner.epoch !== socket.owner.epoch
    )
      return;
    // What a replaced socket had pending fails once the broker closes it.
    this.sockets.set(id, socket);
    if (!current) this.changed(id);
  }
  /** The socket closed: it takes no commands, and what it had pending fails. */
  left(socket) {
    for (const [key, entry] of this.pending)
      if (entry.socket === socket) this.settle(key, null, taskStopError.channelDown());
    const id = socket.owner?.id;
    if (this.sockets.get(id) !== socket) return;
    this.sockets.delete(id);
    this.changed(id);
  }
  /** A message of an authenticated socket; true when it was a command result. */
  receive(socket, message) {
    if (message?.type !== "command-result") return false;
    const entry = typeof message.id === "string" && this.pending.get(message.id);
    // Only the socket the command went to answers it.
    if (!entry || entry.socket !== socket) return true;
    this.settle(message.id, {
      ok: message.ok === true,
      ...(typeof message.reason === "string"
        ? { reason: message.reason.slice(0, MAX_REASON) }
        : {}),
      ...(message.data !== undefined ? { data: message.data } : {}),
    });
    return true;
  }
  connected(sessionId) {
    return this.sockets.has(sessionId);
  }
  /**
   * Send `{ name, params }` to the session's commands socket. Resolves the
   * owner's `{ ok, reason?, data? }`; rejects TASK_STOP_CHANNEL_DOWN without such a
   * socket or when it closes first, and TASK_STOP_TIMEOUT after `timeoutMs`.
   */
  send(sessionId, { name, params } = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const socket = this.sockets.get(sessionId);
    if (!socket || socket.destroyed || this.pending.size >= MAX_PENDING)
      return Promise.reject(taskStopError.channelDown());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(id, null, taskStopError.timeout()),
        timeoutMs,
      );
      timer.unref?.();
      this.pending.set(id, { socket, resolve, reject, timer });
      if (!write(socket, { type: "command", id, name, params: params ?? {} }))
        this.settle(id, null, taskStopError.channelDown());
    });
  }
  settle(id, result, error) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(result);
  }
  changed(sessionId) {
    try {
      this.onChange(sessionId);
    } catch {
      /* Advisory: the next chat read still asks connected(). */
    }
  }
}
