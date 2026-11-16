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
 * `commands: true`; the newest such socket of a session gets them. The server makes
 * every command id, and only that socket's result for that id settles the command.
 * Held in memory: a closed socket or a timeout ends what it had pending.
 */
export class NativeCommands {
  /** `onChange(sessionId)` hears that a session's command channel came up or went down. */
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    // Commands-capable sockets per session, oldest first.
    this.sockets = new Map();
    this.pending = new Map();
  }
  /** An authenticated owner socket said hello. */
  joined(socket, hello) {
    if (hello?.commands !== true || !socket.owner) return;
    const id = socket.owner.id;
    const list = this.sockets.get(id) || [];
    this.sockets.set(id, [...list.filter((item) => item !== socket), socket]);
    if (!list.length) this.changed(id);
  }
  /** The socket closed: it takes no commands, and what it had pending fails. */
  left(socket) {
    const id = socket.owner?.id;
    const list = this.sockets.get(id);
    if (!list?.includes(socket)) return;
    const rest = list.filter((item) => item !== socket);
    if (rest.length) this.sockets.set(id, rest);
    else this.sockets.delete(id);
    for (const [key, entry] of this.pending)
      if (entry.socket === socket) this.settle(key, null, taskStopError.channelDown());
    if (!rest.length) this.changed(id);
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
    return Boolean(this.sockets.get(sessionId)?.length);
  }
  /**
   * Send `{ name, params }` to the session's newest commands socket. Resolves the
   * owner's `{ ok, reason?, data? }`; rejects TASK_STOP_CHANNEL_DOWN without such a
   * socket or when it closes first, and TASK_STOP_TIMEOUT after `timeoutMs`.
   */
  send(sessionId, { name, params } = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const socket = this.sockets.get(sessionId)?.at(-1);
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
