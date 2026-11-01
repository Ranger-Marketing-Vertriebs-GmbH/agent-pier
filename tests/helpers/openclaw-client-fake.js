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
 * (`approvals`, as `exec.approval.list` items), how others ended, the exec
 * allowlist file and the cron jobs with their runs. One store serves every client a supervisor connects in turn.
 */
export const openClawStore = ({ approvals = [] } = {}) => ({
  agents: new Map(),
  files: new Map(),
  config: {},
  writes: 0,
  approvals: new Map(approvals.map((item) => [item.id, structuredClone(item)])),
  ended: [],
  allowlist: { file: { version: 1 }, writes: 0 },
  cron: { jobs: new Map(), runs: new Map(), created: 0 },
  profiles: [],
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
  // Login wizards run in the Gateway process: a restart ends them.
  const wizards = new Set();
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
    ...cronAnswers(store.cron),
    ...modelAnswers(store, wizards),
    "skills.status": ({ agentId } = {}) => {
      if (agentId && !store.agents.has(agentId))
        throw answered("INVALID_REQUEST", `unknown agent id "${agentId}"`);
      return {
        skills: [{ name: "weather", source: "openclaw-bundled", eligible: true }],
      };
    },
    "agentpier.backgroundCommands": () => ({ running: 0, completing: 0 }),
    "agentpier.chatTitle": ({ message }) => ({ title: `About ${message}` }),
  };
  // The browser control service of this Gateway process (`browser.request`).
  const browser = { running: false };
  const browserAnswer = ({ method, path }) => {
    if (method === "POST" && path === "/start") browser.running = true;
    if (method === "POST" && path === "/stop") browser.running = false;
    return path === "/tabs" ? { tabs: [] } : { running: browser.running };
  };
  return Object.assign(new EventEmitter(), {
    ready: true,
    calls,
    async call(method, params, ...options) {
      if (!this.ready) throw gatewayError();
      calls.push([method, params, ...options]);
      if (!answers[method]) throw new Error(`unexpected ${method}`);
      return answers[method](params);
    },
    // Unlike call, request needs only an open socket (gateway-client.js).
    async request(method, params, ...options) {
      if (!this.ready) throw gatewayError();
      calls.push([method, params, ...options]);
      if (method !== "browser.request") throw new Error(`unexpected ${method}`);
      return browserAnswer(params);
    },
    openStream(wsPath) {
      if (
        typeof wsPath !== "string" ||
        !wsPath.startsWith("/") ||
        wsPath.startsWith("//")
      )
        throw gatewayError("RPC_FAILED");
      calls.push(["openStream", wsPath]);
      return { wsPath };
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
  });
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
      // As OpenClaw, the new agent's entry joins the configuration.
      store.config.agents = {
        ...store.config.agents,
        entries: { ...store.config.agents?.entries, [name]: { workspace } },
      };
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

// cron.* over `cron`: paged listings (`limit`, `offset`, `hasMore`, `nextOffset`), the
// created job as `{ job }`, and a run that a disabled job gets only with mode "force".
function cronAnswers(cron) {
  const copy = (value) => structuredClone(value);
  return {
    "cron.list": ({ agentId, limit, offset }) => {
      const all = [...cron.jobs.values()].filter(
        (j) => !agentId || j.agentId === agentId,
      );
      const jobs = all.slice(offset, offset + limit).map(copy);
      const hasMore = offset + limit < all.length;
      return { jobs, hasMore, ...(hasMore && { nextOffset: offset + limit }) };
    },
    "cron.add": (definition) => {
      const job = { ...copy(definition), id: `job-${++cron.created}` };
      cron.jobs.set(job.id, { ...job, updatedAtMs: 1, state: {} });
      return { job: copy(cron.jobs.get(job.id)) };
    },
    "cron.update": ({ id, patch }) => {
      const old = cron.jobs.get(id);
      if (!old) throw answered("INVALID_REQUEST");
      cron.jobs.set(id, { ...old, ...copy(patch), updatedAtMs: old.updatedAtMs + 1 });
      return copy(cron.jobs.get(id));
    },
    "cron.remove": ({ id }) => ({ ok: true, removed: cron.jobs.delete(id) }),
    "cron.run": ({ id, mode }) => {
      const job = cron.jobs.get(id);
      if (!job || (mode !== "force" && !job.enabled))
        return { ok: true, ran: false, reason: job ? "not-due" : "not-found" };
      cron.runs.set(id, [{ ts: Date.now(), status: "ok" }, ...(cron.runs.get(id) || [])]);
      return { ok: true, enqueued: true };
    },
    "cron.runs": ({ id, limit }) => ({
      entries: (cron.runs.get(id) || []).slice(0, limit).map(copy),
    }),
    "cron.status": () => ({ enabled: true, jobs: cron.jobs.size }),
  };
}

// models.* and wizard.*: accounts in `store.profiles`, sign-ins as wizard sessions of
// this process (`wizards`), each finished by its first step.
function modelAnswers(store, wizards) {
  return {
    "models.list": ({ provider }) => ({
      models: [{ id: "gpt-fixture", provider, available: true }],
      providerOutcomes: [],
    }),
    "models.authStatus": () => ({
      providers: [
        { provider: "openai", profiles: store.profiles.map((p) => ({ ...p })) },
      ],
    }),
    "models.probe": ({ profileId }) => ({
      status: store.profiles.some((p) => p.profileId === profileId) ? "ok" : "auth",
    }),
    "models.authLogout": ({ profileIds }) => {
      store.profiles = store.profiles.filter((p) => !profileIds.includes(p.profileId));
      return { ok: true };
    },
    "models.authLogin": ({ sessionId }) => {
      wizards.add(sessionId);
      return { ok: true };
    },
    "wizard.next": ({ sessionId }) => {
      if (!wizards.delete(sessionId)) throw answered("INVALID_REQUEST");
      store.profiles.push({ profileId: "openai:fixture", type: "oauth", status: "ok" });
      return { done: true, status: "done" };
    },
    "wizard.cancel": ({ sessionId }) => {
      wizards.delete(sessionId);
      return { ok: true };
    },
  };
}
