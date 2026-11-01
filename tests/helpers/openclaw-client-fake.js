import { EventEmitter } from "node:events";
import { gatewayError } from "../../server/features/assistants/runtimes/openclaw/gateway-protocol.js";

/**
 * A Gateway client that answers like OpenClaw 2026.10.3 for the runtime port's
 * contract (tests/unit/agent-runtime-port.test.js): channels, sessions and the
 * `agent`/`chat` frames of a run, which ends on later turns of the event loop,
 * finished or with a `chat` error of `errorKind: runFailure`. `calls` records each
 * call as [method, params, options?]. Once closed it refuses every call as
 * GatewayClient does.
 */
export function openClawClientFake({
  channels = {},
  runFailure = null,
  calls = [],
} = {}) {
  const frames = new EventEmitter();
  const sessions = new Map();
  const runs = new Map();
  let created = 0;
  const frame = (event, payload) => frames.emit("event", { event, payload });
  const pause = () => new Promise((resolve) => setImmediate(resolve));
  async function run(sessionKey, runId) {
    await pause();
    frame("agent", { sessionKey, runId, stream: "lifecycle", data: { phase: "start" } });
    await pause();
    frame("chat", { sessionKey, runId, state: "delta", message: { text: "Hi" } });
    await pause();
    runs.set(runId, runFailure ? "error" : "ok");
    if (runFailure)
      frame("chat", { sessionKey, runId, state: "error", errorKind: runFailure });
    else frame("chat", { sessionKey, runId, state: "final" });
  }
  const answers = {
    "channels.status": () => ({ channelAccounts: structuredClone(channels) }),
    "sessions.create": ({ agentId, label }) => {
      const key = `agent:${agentId}:dashboard:${++created}`;
      sessions.set(key, { key, label, sessionId: `s${created}`, messages: [] });
      return { key };
    },
    "sessions.list": () => ({ sessions: [...sessions.values()].map((s) => ({ ...s })) }),
    "sessions.describe": ({ key }) =>
      sessions.has(key) ? { session: { ...sessions.get(key) } } : {},
    "sessions.patch": ({ key, ...patch }) => {
      Object.assign(sessions.get(key), patch);
      return { ok: true };
    },
    "sessions.delete": ({ key }) => ({ ok: sessions.delete(key) }),
    "sessions.send": ({ key, message, idempotencyKey }) => {
      sessions.get(key)?.messages.push({ role: "user", content: message });
      runs.set(idempotencyKey, "running");
      run(key, idempotencyKey);
      return { runId: idempotencyKey };
    },
    "sessions.abort": () => ({ ok: true }),
    "sessions.compact": () => ({ ok: true, compacted: true }),
    "sessions.messages.subscribe": () => ({}),
    "sessions.get": ({ key }) => ({ messages: [...(sessions.get(key)?.messages || [])] }),
    "chat.history": ({ sessionKey }) => ({
      messages: [...(sessions.get(sessionKey)?.messages || [])],
    }),
    "agent.wait": ({ runId }) => ({ runId, status: runs.get(runId) || "timeout" }),
  };
  return {
    ready: true,
    calls,
    async call(method, params, ...options) {
      if (!this.ready) throw gatewayError();
      calls.push([method, params, ...options]);
      if (!answers[method]) throw new Error(`unexpected ${method}`);
      return answers[method](params);
    },
    close() {
      this.ready = false;
    },
    async download(url, { maxBytes }) {
      calls.push(["download", url, { maxBytes }]);
      return { body: Buffer.from("png") };
    },
    subscribe(listener) {
      frames.on("event", listener);
      return () => frames.off("event", listener);
    },
    frame,
  };
}
