import { EventEmitter } from "node:events";
import { defineAgentRuntime } from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  createHermesClient,
  hermesConnectionHost,
} from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesEvents } from "../../server/features/assistants/runtimes/hermes/hermes-events.js";
import { hermesApprovals } from "../../server/features/assistants/runtimes/hermes/hermes-approvals.js";

/**
 * An in-memory duplex in place of a Hermes process's stdio: `transport` is what the
 * client gets (write(line), "line", "close", close()), `peer` the process side
 * (`frames` it received, send(frame), close()). Lines travel on the next microtask,
 * as a pipe never delivers synchronously.
 */
export function memoryTransport() {
  const transport = new EventEmitter();
  const peer = new EventEmitter();
  let closed = false;
  peer.frames = [];
  transport.write = (line) => {
    if (closed) return false;
    queueMicrotask(() => {
      if (closed) return;
      const frame = JSON.parse(line);
      peer.frames.push(frame);
      peer.emit("frame", frame);
    });
    return true;
  };
  peer.send = (frame) => {
    if (!closed)
      queueMicrotask(() => !closed && transport.emit("line", JSON.stringify(frame)));
  };
  peer.sendLine = (line) => !closed && queueMicrotask(() => transport.emit("line", line));
  const close = () => {
    if (closed) return;
    closed = true;
    transport.emit("close");
    peer.emit("close");
  };
  transport.close = close;
  peer.close = close;
  peer.closed = () => closed;
  return { transport, peer };
}

/** What a fake Hermes keeps across its restarts: stored sessions. */
export const hermesStore = () => ({ rows: new Map(), created: 0 });

const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * A Hermes TUI gateway over `peer` that answers like the real one in the frames the
 * adapter uses (docs/research/hermes-runtime-spike.md): gateway.ready on start, live
 * sessions per process over `store`'s stored ones, a turn as message.start, two
 * message.delta and message.complete (status "error" with an error surface of code
 * `runFailure` when given), and an `approval` request per entry of `approvals` once
 * the client declared server requests.
 */
export function fakeHermesGateway(
  peer,
  store,
  { runFailure = null, approvals = [] } = {},
) {
  const live = new Map();
  const keys = new Map();
  let seq = 0;
  const event = (type, sid, payload = {}) =>
    peer.send({
      jsonrpc: "2.0",
      method: "event",
      params: { type, session_id: sid, payload, seq: ++seq },
    });
  const ok = (id, result) => peer.send({ jsonrpc: "2.0", id, result });
  const open = (sid, stored) => {
    live.set(sid, stored);
    keys.set(stored, sid);
  };
  const turn = async (sid, text) => {
    const stored = live.get(sid);
    const row = store.rows.get(stored);
    const pause = () => new Promise((resolve) => setImmediate(resolve));
    await pause();
    event("message.start", sid, { turn_id: `t${seq}` });
    for (const part of ["ECHO: ", text]) {
      await pause();
      event("message.delta", sid, { text: part });
    }
    await pause();
    if (runFailure)
      return event("message.complete", sid, {
        text: "",
        status: "error",
        error: "failed",
        error_surface: { layer: "provider", code: runFailure, retryable: true },
      });
    row?.messages.push({
      role: "assistant",
      text: `ECHO: ${text}`,
      row_id: row.messages.length + 1,
    });
    event("message.complete", sid, { text: `ECHO: ${text}`, status: "complete" });
  };
  const methods = {
    "client.capabilities": (id) => {
      for (const item of approvals)
        peer.send({
          jsonrpc: "2.0",
          id: item.id,
          method: "approval",
          params: {
            session_id: "",
            command: item.request?.command ?? "",
            description: "dangerous command",
            pattern_keys: ["dangerous"],
            allow_session: true,
            allow_permanent: true,
            request_id: `r-${item.id}`,
            timeout_s: 300,
            choices: ["once", "session", "always", "deny"],
          },
        });
      ok(id, { server_requests: ["approval", "clarify"] });
    },
    "session.create": (id) => {
      const n = ++store.created;
      const sid = `live${n}-${Math.random().toString(16).slice(2, 6)}`;
      const stored = `20261101_00000${n}_abc`;
      open(sid, stored);
      ok(id, {
        session_id: sid,
        stored_session_id: stored,
        message_count: 0,
        messages: [],
      });
    },
    "session.title": (id, { session_id: sid, title }) => {
      const stored = live.get(sid);
      if (!stored) return peer.send(error(id, 4001, "session not found"));
      const row = store.rows.get(stored) || { id: stored, messages: [], archived: false };
      store.rows.set(stored, Object.assign(row, { title }));
      ok(id, { pending: false, title });
    },
    "session.list": (id, { title }) =>
      ok(id, {
        sessions: [...store.rows.values()]
          .filter((row) => !row.archived && (title === undefined || row.title === title))
          .map((row) => ({
            id: row.id,
            title: row.title,
            message_count: row.messages.length,
          })),
      }),
    "session.resume": (id, { session_id: stored }) => {
      if (!store.rows.has(stored)) return peer.send(error(id, 4007, "session not found"));
      if (!keys.has(stored)) open(`resumed-${stored}-${seq}`, stored);
      ok(id, { session_id: keys.get(stored), resumed: stored, open_requests: [] });
    },
    "session.history": (id, { session_id: sid }) => {
      if (!live.has(sid)) return peer.send(error(id, 4001, "session not found"));
      const messages = store.rows.get(live.get(sid))?.messages || [];
      ok(id, { count: messages.length, messages });
    },
    "prompt.submit": (id, { session_id: sid, text }) => {
      if (!live.has(sid)) return peer.send(error(id, 4001, "session not found"));
      const row = store.rows.get(live.get(sid));
      row?.messages.push({ role: "user", text, row_id: row.messages.length + 1 });
      ok(id, { status: "streaming" });
      turn(sid, text);
    },
    "session.interrupt": (id) => ok(id, { status: "interrupted" }),
    "session.compress": (id, { session_id: sid }) =>
      live.has(sid)
        ? ok(id, { status: "compressed" })
        : peer.send(error(id, 4001, "session not found")),
    "session.close": (id, { session_id: sid }) => {
      keys.delete(live.get(sid));
      live.delete(sid);
      ok(id, { closed: true });
    },
    "session.delete": (id, { session_id: stored }) => {
      if (keys.has(stored))
        return peer.send(error(id, 4023, "cannot delete an active session"));
      if (!store.rows.delete(stored))
        return peer.send(error(id, 4007, "session not found"));
      ok(id, { deleted: stored });
    },
    "session.archive": (id, { session_id: stored, archived }) => {
      const row = store.rows.get(stored);
      if (!row) return peer.send(error(id, 4001, "session not found"));
      row.archived = archived !== false;
      ok(id, { archived: row.archived, session_key: stored });
    },
    "llm.oneshot": (id, { input }) =>
      ok(id, {
        text: `"About ${String(input).match(/<message>\n?(.*)/)?.[1] || "this"}"\n`,
      }),
  };
  peer.on("frame", (frame) => {
    if (typeof frame.method !== "string") return;
    const method = methods[frame.method];
    if (!method)
      return peer.send(error(frame.id, -32601, `unknown method ${frame.method}`));
    method(frame.id, frame.params || {});
  });
  peer.send({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: {} },
  });
  return { live };
}

/**
 * A supervisor of one fake Hermes process for `agentId`: each start spawns a new
 * gateway over a new transport and client on the same store, stop closes the client
 * as the real supervisor does.
 */
export function fakeHermesSupervisor({
  agentId = "agent-1",
  unreachable = false,
  version = null,
  runFailure = null,
  approvals = [],
} = {}) {
  const store = hermesStore();
  const supervisor = new EventEmitter();
  const state = { availability: "disabled", sync: "stale", version, diagnostic: null };
  const setState = (patch) => {
    Object.assign(state, patch);
    supervisor.emit("status", { ...state });
  };
  let first = true;
  Object.assign(supervisor, {
    agentId,
    client: null,
    store,
    status: () => ({ ...state }),
    async start() {
      setState({ availability: "starting" });
      const { transport, peer } = memoryTransport();
      supervisor.peer = peer;
      fakeHermesGateway(peer, store, { runFailure, approvals: first ? approvals : [] });
      first = false;
      supervisor.client = createHermesClient(transport, { agentId, timeoutMs: 2000 });
      await supervisor.client.connect({ timeoutMs: 2000 });
      setState({ availability: "ready" });
    },
    async stop() {
      supervisor.client?.close();
      supervisor.client = null;
      setState({ availability: "disabled" });
    },
    async restart() {
      await supervisor.stop();
      await supervisor.start();
    },
  });
  if (unreachable)
    Object.assign(state, { availability: "failed", diagnostic: "PROCESS_EXIT" });
  return supervisor;
}

/** The Hermes adapter's host, sessions, events and approvals over `supervisor`. */
export function hermesTestRuntime(supervisor) {
  return defineAgentRuntime({
    id: "hermes",
    host: {
      ...hermesConnectionHost(supervisor),
      status: () => supervisor.status(),
      version: () => supervisor.status().version ?? null,
      subscribe(listener) {
        supervisor.on("status", listener);
        return () => supervisor.off("status", listener);
      },
      start: () => supervisor.start(),
      stop: () => supervisor.stop(),
      restart: () => supervisor.restart(),
    },
    sessions: hermesSessions(supervisor),
    events: hermesEvents(supervisor),
    approvals: hermesApprovals(supervisor),
  });
}

/** `make(state)` for the port contracts: a started fake Hermes for `agentId`. */
export const makeHermesRuntime =
  (agentId = "agent-1") =>
  async (state = {}) => {
    const supervisor = fakeHermesSupervisor({ agentId, ...state });
    if (!state.unreachable) await supervisor.start();
    return hermesTestRuntime(supervisor);
  };
