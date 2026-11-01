import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { gatewayError } from "../../server/features/assistants/runtimes/openclaw/gateway-protocol.js";
import { mergePatch } from "./runtime-port-agents-contract.js";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const answered = (code, remoteMessage = code) =>
  Object.assign(new Error(code), { code, answered: true, status: 400, remoteMessage });

/**
 * What a Gateway keeps on disk across restarts: its agents, their workspace files
 * its configuration with a hash per write, the exec approvals still pending
 * (`approvals`, as `exec.approval.list` items), how others ended and the exec
 * allowlist file. One store serves every client a supervisor connects in turn.
 */
export const openClawStore = ({ approvals = [] } = {}) => ({
  agents: new Map(),
  files: new Map(),
  config: {},
  writes: 0,
  approvals: new Map(approvals.map((item) => [item.id, structuredClone(item)])),
  ended: [],
  allowlist: { file: { version: 1 }, writes: 0 },
});

/**
 * A Gateway client that answers like OpenClaw 2026.10.3 for the runtime port's
 * contract (tests/unit/agent-runtime-port.test.js): channels, sessions and the
 * `agent`/`chat` frames of a run, which ends on later turns of the event loop,
 * finished or with a `chat` error of `errorKind: runFailure`; agents, their files,
 * memory search and the configuration, held in `store` (openClawStore), with a
 * `config.changed` frame after each write. `calls` records each call as [method,
 * params, options?]. Once closed it refuses every call as GatewayClient does.
 */
export function openClawClientFake({
  channels = {},
  runFailure = null,
  calls = [],
  store = openClawStore(),
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
    ...agentAnswers(store, frame),
    ...approvalAnswers(store),
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

// agents.*, agents.files.*, tools.invoke (memory_search) and config.* over `store`.
function agentAnswers(store, frame) {
  const hash = () => `h${store.writes}`;
  const written = () => {
    store.writes++;
    frame("config.changed", { hash: hash() });
  };
  const file = (agentId, name) => {
    const content = store.files.get(`${agentId}/${name}`);
    return content === undefined
      ? { name, missing: true }
      : { name, content, hash: sha256(content) };
  };
  return {
    "agents.list": () => ({ agents: [...store.agents.values()].map((a) => ({ ...a })) }),
    "agents.create": ({ name, workspace, model }) => {
      store.agents.set(name, { id: name, name, workspace, model });
      written();
      return { ok: true, agentId: name };
    },
    "agents.update": ({ agentId, name, model }) => {
      if (!store.agents.has(agentId)) throw answered("INVALID_REQUEST");
      Object.assign(store.agents.get(agentId), { name, model });
      written();
      return { ok: true };
    },
    "agents.delete": ({ agentId }) => {
      const removed = store.agents.delete(agentId);
      if (removed) written();
      return { ok: removed };
    },
    "agents.files.get": ({ agentId, name }) => ({ file: file(agentId, name) }),
    "agents.files.set": ({ agentId, name, content, expectedHash, expectedMissing }) => {
      const current = file(agentId, name);
      if (expectedMissing === true && !current.missing) throw answered("CONFLICT");
      if (expectedHash !== undefined && current.hash !== expectedHash)
        throw answered("CONFLICT");
      store.files.set(`${agentId}/${name}`, content);
      return { ok: true, file: file(agentId, name) };
    },
    "tools.invoke": ({ name, agentId, args }) => {
      if (name !== "memory_search") throw answered("INVALID_REQUEST");
      const results = [...store.files.entries()]
        .filter(
          ([key, text]) => key.startsWith(`${agentId}/`) && text.includes(args.query),
        )
        .slice(0, args.maxResults)
        .map(([key, text]) => ({
          path: key.slice(agentId.length + 1),
          snippet: text,
          startLine: 1,
          endLine: 1,
        }));
      return { ok: true, output: { details: { results } } };
    },
    "config.get": () => ({ config: structuredClone(store.config), hash: hash() }),
    "config.schema.lookup": ({ path }) => ({ path, reloadKind: "hot" }),
    "config.patch": ({ baseHash, raw }) => {
      // OpenClaw refuses a stale base hash with the generic INVALID_REQUEST.
      if (baseHash !== hash()) throw answered("INVALID_REQUEST");
      store.config = mergePatch(store.config, JSON.parse(raw));
      written();
      return { ok: true };
    },
  };
}

// exec.approval.list/resolve, approval.history and exec.approvals.get/set.
function approvalAnswers(store) {
  const statuses = { deny: "denied", "allow-once": "allowed", "allow-always": "allowed" };
  const hash = () => `a${store.allowlist.writes}`;
  return {
    "exec.approval.list": () =>
      [...store.approvals.values()].map((item) => structuredClone(item)),
    "exec.approval.resolve": ({ id, decision }) => {
      if (!store.approvals.delete(id)) throw answered("INVALID_REQUEST");
      store.ended.push({ id, status: statuses[decision], decision });
      return { ok: true };
    },
    "approval.history": () => ({ items: store.ended.map((item) => ({ ...item })) }),
    "exec.approvals.get": () => ({
      file: structuredClone(store.allowlist.file),
      hash: hash(),
    }),
    "exec.approvals.set": ({ baseHash, file }) => {
      if (baseHash !== hash())
        throw answered(
          "INVALID_REQUEST",
          "exec approvals changed since last load; re-run exec.approvals.get and retry",
        );
      store.allowlist.file = structuredClone(file);
      store.allowlist.writes++;
      return { ok: true };
    },
  };
}
