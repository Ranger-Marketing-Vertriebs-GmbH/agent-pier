import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { ExecApprovals } from "../../server/features/assistants/exec-approvals.js";

// An ExecApprovals instance over a fake Gateway client, a disposable store, one
// agent and its main conversation (tests/unit/exec-approvals*.test.js).
export const settle = () => new Promise((resolve) => setImmediate(resolve));

// A fake Gateway client: events go through the hub, calls are recorded and answered
// from `answers`.
export function gatewayClient(answers = {}) {
  const emitter = new EventEmitter();
  return {
    ready: true,
    calls: [],
    answers,
    async call(method, params) {
      this.calls.push({ method, params });
      const answer = this.answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : answer;
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    emit: (event, payload) => emitter.emit("event", { event, payload }),
  };
}

export function fixture(
  t,
  { shell = "approval", answers, retryMs = 1, retries = 5 } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-approvals-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "test", modelId: "test" },
    shell,
  });
  const chat = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "agent:home:main",
  });
  const ledger = new RequestLedger(store.db);
  const contexts = new Map();
  const client = gatewayClient(answers);
  const gatewayEvents = new GatewayEventHub();
  gatewayEvents.bind(client);
  let changes = 0;
  const queued = [];
  const w = {
    s: {
      assistantChannels: {
        outbox: { all: () => queued, enqueue: (entry) => queued.push(entry) },
        store: { get: () => ({ language: "en" }) },
      },
    },
    store: new AssistantActionStore(store.db),
    a: {
      store,
      ledger,
      gatewayEvents,
      runtime: { client },
      teams: { store: { context: (id) => contexts.get(id) || { kind: "owner" } } },
      changed: () => changes++,
    },
  };
  const logged = [];
  const exec = new ExecApprovals(w, {
    log: (line) => logged.push(line),
    retryMs,
    retries,
  });
  t.after(() => exec.close());
  return {
    w,
    exec,
    agent,
    chat,
    ledger,
    contexts,
    client,
    gatewayEvents,
    logged,
    queued,
    changes: () => changes,
  };
}

export const request = (agent, overrides = {}) => ({
  id: "approval-1",
  request: {
    command: "touch /tmp/x",
    cwd: "/work",
    agentId: agent.runtimeAgentId,
    sessionKey: "agent:home:main",
    runId: "run-1",
    resolvedPath: "/usr/bin/touch",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    ...overrides,
  },
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 1800000,
});
