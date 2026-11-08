import { EventEmitter } from "node:events";
import { defineAgentRuntime } from "../../server/features/assistants/runtimes/agent-runtime.js";
import {
  createHermesClient,
  hermesConnectionHost,
} from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesSessions } from "../../server/features/assistants/runtimes/hermes/hermes-sessions.js";
import { hermesEvents } from "../../server/features/assistants/runtimes/hermes/hermes-events.js";
import { hermesApprovals } from "../../server/features/assistants/runtimes/hermes/hermes-approvals.js";
import {
  HermesRoutineDeliveries,
  hermesRoutines,
} from "../../server/features/assistants/runtimes/hermes/hermes-routines.js";
import { cronRest, cronStore } from "./hermes-fake-cron.js";

/**
 * An in-memory duplex in place of the RPC bridge's channel: `transport` is what the
 * client gets (write(line), "line", "close", close()), `peer` the gateway side
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

/** What a fake Hermes keeps across its restarts: sessions, admissions, cron jobs. */
export const hermesStore = () => ({
  rows: new Map(),
  created: 0,
  admissions: new Map(),
  images: 0,
  cron: cronStore(),
});

// A refusal as the gateway's session store answers it: code 4001, the reason as
// message and in `data` with the fences it names.
const refusal = (id, reason, data = {}) => ({
  jsonrpc: "2.0",
  id,
  error: { code: 4001, message: reason, data: { reason, ...data } },
});

/**
 * The session store of a Hermes messaging gateway over `peer`, in the frames the
 * adapter uses (docs/hermes-runtime.md, "Gateway protocol"): gateway.ready on start,
 * sessions stored in `store` (durable ids, unique titles, idempotent create by
 * `request_id`) that a connection attaches to (`session.resume`) before it submits,
 * a turn as message.start, two message.delta and message.complete carrying its
 * `admission_id` and `execution_generation` (status "error" with an error surface of
 * code `runFailure` when given), revision-fenced `session.mutate`, an
 * `approval.request` event per entry of `approvals` once the client declared server
 * requests, `session.stats` from a row's `stats` (set by a test), and the bridge's
 * `agentpier.http` over the cron routes (hermes-fake-cron.js) and `agentpier.note`,
 * which appends an `internal_notification` user row.
 */
export function fakeHermesGateway(
  peer,
  store,
  { runFailure = null, approvals = [] } = {},
) {
  const attached = new Set();
  let seq = 0;
  const event = (type, sid, payload = {}, extra = {}) =>
    peer.send({
      jsonrpc: "2.0",
      method: "event",
      params: { type, session_id: sid, payload, seq: ++seq, ...extra },
    });
  const ok = (id, result) => peer.send({ jsonrpc: "2.0", id, result });
  const snapshot = (row) => ({
    session_id: row.id,
    stored_session_id: row.id,
    message_count: row.messages.length,
    revision: row.revision,
    execution_generation: row.generation,
    subscription_id: `sub-${row.id}`,
    prompts: [],
  });
  const turn = async (row, text, admission) => {
    const sid = row.id;
    const pause = () => new Promise((resolve) => setImmediate(resolve));
    row.generation++;
    const frame = { admission_id: admission, execution_generation: row.generation };
    await pause();
    event("message.start", sid, {}, frame);
    for (const part of ["ECHO: ", text]) {
      await pause();
      event("message.delta", sid, { text: part }, frame);
    }
    await pause();
    if (runFailure)
      return event(
        "message.complete",
        sid,
        {
          text: "",
          status: "error",
          error: "failed",
          error_surface: { layer: "provider", code: runFailure, retryable: true },
        },
        frame,
      );
    row.messages.push({
      role: "assistant",
      text: `ECHO: ${text}`,
      row_id: row.messages.length + 1,
    });
    event("message.complete", sid, { text: `ECHO: ${text}`, status: "complete" }, frame);
  };
  const stored = (id, sid) => {
    const row = store.rows.get(sid);
    if (!row) peer.send(refusal(id, "not_found"));
    return row;
  };
  const methods = {
    "client.capabilities": (id) => {
      for (const item of approvals)
        event("approval.request", "", {
          kind: "approval",
          prompt_id: item.id,
          execution_generation: 0,
          command: item.request?.command ?? "",
          description: "dangerous command",
          choices: ["once", "deny", "session", "always"],
          timeout_s: 300,
        });
      ok(id, { server_requests: ["approval", "clarify"] });
    },
    "session.create": (id, { request_id: request, title }) => {
      let row = [...store.rows.values()].find(
        (r) => r.request === request || (title && r.title === title),
      );
      if (!row) {
        const n = ++store.created;
        row = {
          id: `local-${n}abc`,
          request,
          title,
          messages: [],
          archived: false,
          revision: 0,
          generation: 0,
        };
        store.rows.set(row.id, row);
      }
      attached.add(row.id);
      ok(id, snapshot(row));
    },
    "session.list": (id, { title }) => {
      const row = [...store.rows.values()].find((r) => r.title === title);
      ok(id, {
        scope: "stored",
        sessions: row
          ? [
              {
                session_id: row.id,
                id: row.id,
                title,
                message_count: row.messages.length,
              },
            ]
          : [],
      });
    },
    "session.resume": (id, { session_id: sid }) => {
      const row = stored(id, sid);
      if (!row) return;
      attached.add(sid);
      ok(id, snapshot(row));
    },
    "session.history": (id, { session_id: sid }) => {
      const row = stored(id, sid);
      if (row) ok(id, { count: row.messages.length, messages: row.messages });
    },
    "prompt.submit": (
      id,
      { session_id: sid, text, submission_id: submission, attachments },
    ) => {
      if (!attached.has(sid)) return peer.send(refusal(id, "permission_denied"));
      if (!submission) return peer.send(refusal(id, "invalid_params"));
      const row = stored(id, sid);
      if (!row) return;
      const known = store.admissions.get(submission);
      if (known) return ok(id, { admission_id: known, status: "terminal" });
      const admission = `adm-${store.admissions.size + 1}`;
      store.admissions.set(submission, admission);
      // The stored row names the turn's images after its text, and its text view
      // shows a placeholder per image part (gateway/session_ingress_media.py,
      // agent/image_routing.py build_native_content_parts).
      const images = attachments || [];
      row.turnImages = [...(row.turnImages || []), images];
      const kept = images.length
        ? [
            `${text}\n`,
            ...images.map((image) => `[Image attached at: ${image.path}]`),
            ...images.map(() => "[screenshot]"),
          ].join("\n")
        : text;
      row.messages.push({ role: "user", text: kept, row_id: row.messages.length + 1 });
      ok(id, { admission_id: admission, status: "queued" });
      turn(row, text, admission);
    },
    // gateway/session_images.py: staged in the image cache, named by the submit;
    // `invalid_params` for bytes that are no image it takes.
    "image.attach_bytes": (id, { session_id: sid, content_base64: data, ext }) => {
      if (!attached.has(sid)) return peer.send(refusal(id, "permission_denied"));
      if (!/^[A-Za-z0-9+/]+=*$/.test(data || ""))
        return peer.send(refusal(id, "invalid_params"));
      const mime = { png: "image/png", jpg: "image/jpeg" }[ext] || `image/${ext}`;
      ok(id, {
        attached: true,
        path: `/home/cache/images/upload_${++store.images}.${ext}`,
        mime,
      });
    },
    "session.interrupt": (id, { session_id: sid, execution_generation: generation }) => {
      const row = stored(id, sid);
      if (!row) return;
      if (generation !== row.generation)
        return peer.send(
          refusal(id, "stale_generation", { execution_generation: row.generation }),
        );
      ok(id, { execution_state: "idle" });
    },
    "session.mutate": (id, params) => {
      const row = stored(id, params.session_id);
      if (!row) return;
      if (params.expected_revision !== row.revision)
        return peer.send(
          refusal(id, "revision_conflict", {
            revision: row.revision,
            execution_generation: row.generation,
          }),
        );
      const receipt = (extra) => {
        row.revision++;
        ok(id, {
          session_id: row.id,
          operation: params.operation,
          revision: row.revision,
          execution_generation: row.generation,
          ...extra,
        });
      };
      if (params.operation === "archive") {
        row.archived = params.payload.archived;
        return receipt({ archived: row.archived });
      }
      if (params.operation === "compress") return receipt({ status: "compressed" });
      if (params.operation === "delete") {
        store.rows.delete(row.id);
        attached.delete(row.id);
        return receipt({ deleted_ids: [row.id] });
      }
      peer.send(refusal(id, "invalid_params"));
    },
    "approval.respond": (id, { session_id: sid, prompt_id: prompt }) => {
      ok(id, { status: "resolved", prompt_id: prompt });
      event("approval.settled", sid, { prompt_id: prompt, execution_generation: 0 });
    },
    "agentpier.http": (id, params) =>
      ok(
        id,
        cronRest(store.cron, store.rows, params, {
          changed: () => event("cron.changed", "", {}),
        }),
      ),
    "agentpier.note": (id, { session_id: sid, text }) => {
      const row = store.rows.get(sid);
      if (!row) return ok(id, { appended: false, reason: "not_found" });
      row.messages.push({
        role: "user",
        text,
        display_kind: "internal_notification",
        row_id: row.messages.length + 1,
      });
      ok(id, { appended: true });
    },
    "session.stats": (id, { session_id: sid }) => {
      const row = stored(id, sid);
      if (row) ok(id, { last_prompt_tokens: 0, context_length: 0, ...row.stats });
    },
    // gateway/session_config.py model_options: the home's model inventory.
    "model.options": (id, params) =>
      ok(id, {
        providers: [{ slug: "custom", models: ["fake-1"] }],
        refreshed: params.refresh === true,
      }),
    "llm.oneshot": (id, { input }) =>
      ok(id, {
        text: `"About ${String(input).match(/<message>\n?(.*)/)?.[1] || "this"}"\n`,
      }),
  };
  peer.on("frame", (frame) => {
    if (typeof frame.method !== "string") return;
    const method = methods[frame.method];
    if (!method)
      return peer.send({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: `unknown method: ${frame.method}` },
      });
    method(frame.id, frame.params || {});
  });
  peer.send({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: {} },
  });
  return { attached };
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

/**
 * The Hermes adapter's host, sessions, events, approvals and routines over
 * `supervisor`; routine results are posted with `post` (default: dropped), the
 * deliveries following the current client as the runtime's do.
 */
export function hermesTestRuntime(
  supervisor,
  { post = async () => ({ ok: true }), zone } = {},
) {
  const deliveries = new HermesRoutineDeliveries({
    supervisor,
    token: () => "t".repeat(64),
    post,
    zone,
  });
  supervisor.deliveries = deliveries;
  supervisor.on("status", ({ availability }) =>
    deliveries.follow(availability === "ready" ? supervisor.client : null),
  );
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
    routines: hermesRoutines(supervisor, { deliveries, zone }),
  });
}

/** `make(state)` for the port contracts: a started fake Hermes for `agentId`. */
export const makeHermesRuntime =
  (agentId = "agent-1") =>
  async (state = {}) => {
    const supervisor = fakeHermesSupervisor({ agentId, ...state });
    const runtime = hermesTestRuntime(supervisor, state);
    if (!state.unreachable) await supervisor.start();
    return runtime;
  };
