import { EventEmitter } from "node:events";

// Hermes's gateway serves its sessions as JSON-RPC 2.0 over its TUI WebSocket
// (`/api/ws`), which the RPC bridge (hermes-rpc-bridge.py) relays as newline-delimited
// frames on its stdio, the same protocol as `python -m tui_gateway.entry`: requests
// with ids both ways, and notifications
// `{ method: "event", params: { type, session_id, payload, seq } }`. The process
// announces itself with the event `gateway.ready`; a client that answers the gateway's
// own requests (approval, clarify, …) says so once with `client.capabilities
// { server_requests: true }`, or Hermes fails each such request at once.
// docs/research/hermes-runtime-spike.md records the frames this client was built on.

// What a request the gateway sent may be answered with when AgentPier has no handler:
// JSON-RPC's "method not found", which makes the agent fail fast instead of waiting.
export const methodNotFound = -32601;

/**
 * A failure of the connection itself, never an answer of Hermes: the same shape as
 * OpenClaw's gatewayError (`code`, `status: 503`), so callers that tell an unreachable
 * runtime from an answer (`answered`) treat both runtimes alike.
 */
export function hermesError(code = "UNAVAILABLE") {
  return Object.assign(Error(`Assistant Gateway unavailable (${code}).`), {
    code,
    status: 503,
  });
}

// A pending call when the transport closed, as OpenClaw's closed client rejects it.
const closedError = () =>
  Object.assign(Error("Assistant Gateway closed."), { code: "CLOSED", status: 503 });

// Hermes's refusals as the port's string codes. The gateway's session store answers
// every refusal with code 4001 and names it in `error.data.reason` (and as the
// message): `invalid_params` for a missing or unknown parameter, `not_found`,
// `session_busy` while a turn runs, `stale_generation` and `revision_conflict` for a
// control or edit fenced on an older state, `permission_denied` for a session this
// connection is not attached to. -32601 is JSON-RPC's unknown method.
const reasonCodes = {
  invalid_params: "INVALID_REQUEST",
  not_found: "NOT_FOUND",
  session_busy: "BUSY",
  admission_started: "BUSY",
  stale_generation: "CONFLICT",
  revision_conflict: "CONFLICT",
  admission_conflict: "CONFLICT",
  permission_denied: "FORBIDDEN",
};
const numberCodes = { [-32601]: "UNKNOWN_METHOD", [-32602]: "INVALID_REQUEST" };
const reasonOf = (error) => {
  const reason = error?.data?.reason ?? error?.message;
  return typeof reason === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(reason)
    ? reason
    : null;
};
// The fences a refusal names: the session's current revision and generation.
const fencesOf = (data) =>
  Object.fromEntries(
    ["revision", "execution_generation"]
      .filter((name) => Number.isSafeInteger(data?.[name]))
      .map((name) => [name, data[name]]),
  );

/**
 * An error Hermes answered: `answered` separates it from a transport failure;
 * `hermesCode` is its number, `reason` its refusal reason, `fences` the revision and
 * execution generation it named.
 */
export function answeredError(error) {
  const hermesCode = Number.isSafeInteger(error?.code) ? error.code : null;
  const reason = reasonOf(error);
  return Object.assign(
    hermesError(reasonCodes[reason] || numberCodes[hermesCode] || "RPC_FAILED"),
    { answered: true, hermesCode, reason, fences: fencesOf(error?.data) },
    // Hermes's reason, for callers that must tell one refusal from another; it may
    // name host paths, so it is never logged or shown.
    typeof error?.message === "string"
      ? { remoteMessage: error.message.slice(0, 300) }
      : {},
  );
}

/**
 * The transport a client runs over: the supervisor builds it over the RPC bridge's
 * channel (hermes-transport.js rpcTransport); the unit tests over memory.
 * - write(line): sends one frame, a JSON text without its newline; false or a throw
 *   when the peer is gone.
 * - on("line", listener) / off: each frame Hermes sent, as its JSON text or already
 *   parsed.
 * - on("close", listener) / off: once, when the peer is gone for good.
 * - close(): optional; ends the transport (the client calls it from close()).
 */

/**
 * One connection to one Hermes process over `transport`. `connect()` resolves once
 * the gateway is ready and knows this client answers its requests; until then and
 * after the transport closed, call() rejects (UNAVAILABLE, 503) and calls in flight
 * reject with CLOSED (503), as OpenClaw's Gateway client does. A closed client never
 * reconnects: the supervisor starts a new process with a new client, which the
 * runtime port sees as a new connection (host.connection()).
 *
 * Events: "event" with each event notification's params, "disconnected" once.
 * handle(method, handler) answers the gateway's requests of that method; any other
 * request is answered -32601 at once.
 */
export class HermesRpcClient extends EventEmitter {
  constructor(transport, { timeoutMs = 10000 } = {}) {
    super();
    Object.assign(this, { transport, timeoutMs });
    this.ready = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    // Requests that timed out but whose caller still wants a late answer (onLate).
    this.late = new Map();
    this.handlers = new Map();
    this.gatewayReady = false;
    this.onLine = (line) => this.receive(line);
    this.onClose = () => this.dropped();
    transport.on("line", this.onLine);
    transport.on("close", this.onClose);
  }

  /**
   * Waits for `gateway.ready`, then declares server requests (`client.capabilities`);
   * resolves once calls may go out. Rejects (TIMEOUT or UNAVAILABLE) otherwise.
   */
  async connect({ timeoutMs = 120000 } = {}) {
    if (this.ready) return;
    if (this.closed) throw hermesError();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(hermesError("TIMEOUT"));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onDrop = () => {
        cleanup();
        reject(hermesError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off("gateway-ready", onReady);
        this.off("disconnected", onDrop);
      };
      if (this.gatewayReady) return onReady();
      this.on("gateway-ready", onReady);
      this.on("disconnected", onDrop);
    });
    this.capabilities = await this.request("client.capabilities", {
      server_requests: true,
    });
    this.ready = true;
  }

  call(method, params = {}, options = {}) {
    if (!this.ready) return Promise.reject(hermesError());
    return this.request(method, params, options);
  }

  // `onLate(ok, result)`: the answer to a request that timed out, if it arrives on
  // this connection within `lateMs`; called at most once, never after a close.
  request(
    method,
    params = {},
    { timeoutMs = this.timeoutMs, onLate, lateMs = 300000 } = {},
  ) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(hermesError());
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (typeof onLate === "function") {
          const expiry = setTimeout(() => this.late.delete(id), lateMs);
          expiry.unref?.();
          this.late.set(id, { onLate, expiry });
        }
        reject(hermesError("TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(hermesError());
      }
    });
  }

  /** Answers the gateway's requests of `method` with `handler(params, { id })`. */
  handle(method, handler) {
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }

  /** `listener(params)` for each event notification; returns unsubscribe. */
  subscribe(listener) {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  /** Sends the answer to a gateway request: `{ result }` or `{ error }`. */
  respond(id, answer) {
    return this.send({ jsonrpc: "2.0", id, ...answer });
  }

  send(frame) {
    if (this.closed) return false;
    try {
      return this.transport.write(JSON.stringify(frame)) !== false;
    } catch {
      return false;
    }
  }

  receive(line) {
    let frame = line;
    if (typeof line === "string")
      try {
        frame = JSON.parse(line);
      } catch {
        // Hermes keeps its stdout to frames; anything else is noise, never a frame.
        return;
      }
    if (!frame || typeof frame !== "object") return;
    if (frame.method === "event" && frame.id === undefined) {
      const params = frame.params && typeof frame.params === "object" ? frame.params : {};
      if (params.type === "gateway.ready" && !this.gatewayReady) {
        this.gatewayReady = true;
        this.emit("gateway-ready", params.payload);
      }
      this.emit("event", params);
      return;
    }
    if (typeof frame.method === "string" && frame.id !== undefined)
      return this.serve(frame);
    if (frame.id !== undefined) this.settle(frame);
  }

  settle(frame) {
    const pending = this.pending.get(frame.id);
    if (!pending) return this.answeredLate(frame);
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.error) pending.reject(answeredError(frame.error));
    else pending.resolve(frame.result);
  }

  async serve({ id, method, params }) {
    const handler = this.handlers.get(method);
    if (!handler)
      return this.respond(id, {
        error: { code: methodNotFound, message: `${method} is not handled` },
      });
    // A handler answers later itself (an approval waits for the owner) by returning
    // undefined; a value or a throw answers now.
    try {
      const result = await handler(params || {}, { id });
      if (result !== undefined) this.respond(id, { result });
    } catch (error) {
      this.respond(id, {
        error: {
          code: Number.isSafeInteger(error?.rpcCode) ? error.rpcCode : methodNotFound,
          message: "request not answered",
        },
      });
    }
  }

  answeredLate(frame) {
    const late = this.late.get(frame.id);
    if (!late) return;
    clearTimeout(late.expiry);
    this.late.delete(frame.id);
    try {
      late.onLate(!frame.error, frame.error ? undefined : frame.result);
    } catch {
      /* A late answer is evidence only; its handler never breaks the connection. */
    }
  }

  dropped() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.transport.off("line", this.onLine);
    this.transport.off("close", this.onClose);
    for (const { expiry } of this.late.values()) clearTimeout(expiry);
    this.late.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pending.clear();
    this.emit("disconnected");
  }

  /** Ends the connection: pending calls reject (CLOSED), later ones are refused. */
  close() {
    if (this.closed) return;
    try {
      this.transport.close?.();
    } catch {
      /* The process may be gone already. */
    }
    this.dropped();
  }
}
