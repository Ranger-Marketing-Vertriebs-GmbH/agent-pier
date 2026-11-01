import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { agentCreateTimeoutMs } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import {
  admittingOn,
  agentDegradedOn,
  admissionDoneOn,
  noteRefusalOn,
  withAdmission,
} from "../../server/features/assistants/agent-admission.js";

// A client that records each call as [method, params, options?] and answers
// `answer(method, params)`; agents.list answers an admitted roster by default.
function recorder(answer = () => ({})) {
  const client = new EventEmitter();
  return Object.assign(client, {
    calls: [],
    ready: true,
    async call(method, ...rest) {
      client.calls.push([method, ...rest]);
      return answer(method, rest[0]) ?? (method === "agents.list" ? { agents: [] } : {});
    },
  });
}
// The calls besides the admission's roster reads.
const writes = (client) => client.calls.filter(([method]) => method !== "agents.list");

test("the agents sub-port sends the Gateway requests callers sent before the port", async () => {
  const client = recorder((method, params) =>
    method === "agents.create" ? { agentId: params.name } : undefined,
  );
  const { agents } = createOpenClawRuntime({ client });
  assert.deepEqual(await agents.list(), { agents: [] });
  await agents.create({ name: "ap-1", workspace: "/w/1", model: "openai/gpt" });
  await agents.update({ agentId: "ap-1", name: "Ada", model: "openai/gpt" });
  await agents.delete({ agentId: "ap-1", deleteFiles: false });
  assert.deepEqual(writes(client), [
    [
      "agents.create",
      { name: "ap-1", workspace: "/w/1", model: "openai/gpt" },
      { timeoutMs: agentCreateTimeoutMs },
    ],
    ["agents.update", { agentId: "ap-1", name: "Ada", model: "openai/gpt" }],
    ["agents.delete", { agentId: "ap-1", deleteFiles: false }],
  ]);
  // The first roster read is the list itself, the next the admission wait.
  assert.deepEqual(client.calls[0], ["agents.list", {}]);
});

test("agent writes and config patches of one connection wait for admission and each other", async () => {
  const order = [];
  let release;
  const admitted = new Promise((resolve) => (release = resolve));
  let rosters = 0;
  const client = recorder((method) => {
    if (method === "agents.list")
      return rosters++ === 0
        ? admitted.then(() => ({ agents: [] }))
        : { agents: [{ id: "ap-1" }] };
    order.push(method);
    if (method === "config.get") return { hash: "h1", config: {} };
    return undefined;
  });
  const runtime = createOpenClawRuntime({ client });
  const update = runtime.agents.update({ agentId: "ap-1", name: "A", model: "m" });
  const patch = runtime.config.patch({ build: () => ({ patch: { a: 1 } }) });
  await new Promise((resolve) => setImmediate(resolve));
  // Nothing is written while the Gateway still admits agents.
  assert.deepEqual(order, []);
  release();
  await Promise.all([update, patch]);
  assert.deepEqual(order, ["agents.update", "config.get", "config.patch"]);
  // Settled once per connection; a reconnect asks again.
  await runtime.agents.settled();
  assert.equal(rosters, 1);
  client.emit("disconnected");
  await runtime.agents.settled();
  assert.equal(rosters, 2);
});

test("waitListed reads the roster until it names the agent", async () => {
  let reads = 0;
  const client = recorder((method) =>
    method === "agents.list"
      ? { agents: ++reads > 2 ? [{ id: "ap-1" }] : [] }
      : undefined,
  );
  const { agents } = createOpenClawRuntime({ client });
  let at = 0;
  await agents.waitListed({
    agentId: "ap-1",
    now: () => at,
    sleep: async (ms) => void (at += ms),
  });
  assert.equal(reads, 3);
  await assert.rejects(
    agents.waitListed({
      agentId: "ap-2",
      timeoutMs: 10,
      now: () => at,
      sleep: async (ms) => void (at += ms),
      warn: () => {},
    }),
    (error) => error.status === 503 && error.key === "agentLoading",
  );
});

test("the agentFiles sub-port sends the Gateway requests callers sent before the port", async () => {
  const client = recorder();
  const { agentFiles } = createOpenClawRuntime({ client });
  await agentFiles.get({ agentId: "ap-1", name: "AGENTS.md" });
  await agentFiles.set({ agentId: "ap-1", name: "AGENTS.md", content: "x" });
  await agentFiles.set({
    agentId: "ap-1",
    name: "MEMORY.md",
    content: "y",
    expectedMissing: true,
  });
  await agentFiles.set({
    agentId: "ap-1",
    name: "USER.md",
    content: "z",
    expectedHash: "a".repeat(64),
  });
  await agentFiles.searchMemory({ agentId: "ap-1", query: "quartz", maxResults: 12 });
  assert.deepEqual(client.calls, [
    ["agents.files.get", { agentId: "ap-1", name: "AGENTS.md" }],
    ["agents.files.set", { agentId: "ap-1", name: "AGENTS.md", content: "x" }],
    [
      "agents.files.set",
      { agentId: "ap-1", name: "MEMORY.md", content: "y", expectedMissing: true },
    ],
    [
      "agents.files.set",
      { agentId: "ap-1", name: "USER.md", content: "z", expectedHash: "a".repeat(64) },
    ],
    [
      "tools.invoke",
      {
        name: "memory_search",
        agentId: "ap-1",
        sessionKey: "agent:ap-1:main",
        args: { query: "quartz", maxResults: 12 },
      },
    ],
  ]);
});

test("the config sub-port sends the Gateway requests callers sent before the port", async () => {
  const client = recorder((method) =>
    method === "config.get" ? { hash: "h1", config: { cron: {} } } : undefined,
  );
  const { config } = createOpenClawRuntime({ client });
  await config.get();
  await config.lookup({ path: "agents.defaults.timeoutSeconds" });
  const base = await config.patch({
    build: (current) => ({ patch: { cron: { enabled: !current.cron.enabled } } }),
  });
  assert.equal(base.hash, "h1");
  await config.patch({
    build: () => ({ patch: { tools: { allow: [] } }, replacePaths: ["tools.allow"] }),
  });
  assert.equal(await config.patch({ build: () => null }), null);
  assert.deepEqual(writes(client), [
    ["config.get", {}],
    ["config.schema.lookup", { path: "agents.defaults.timeoutSeconds" }],
    ["config.get", {}],
    ["config.patch", { baseHash: "h1", raw: '{"cron":{"enabled":true}}' }],
    ["config.get", {}],
    [
      "config.patch",
      { baseHash: "h1", raw: '{"tools":{"allow":[]}}', replacePaths: ["tools.allow"] },
    ],
    ["config.get", {}],
  ]);
});

test("watchAdoption follows the current client's config.changed frames", async () => {
  const listeners = new Set();
  const client = Object.assign(recorder(), {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const { config } = createOpenClawRuntime({ client });
  const watch = config.watchAdoption({ timeoutMs: 1000, warn: () => {} });
  assert.equal(watch.watching, true);
  watch.mark();
  const settled = watch.settle("h1", "h2");
  for (const listener of listeners)
    listener({ event: "config.changed", payload: { hash: "h2" } });
  assert.equal(await settled, true);
  watch.close();
  assert.equal(listeners.size, 0);
  // A client without events is not watched.
  const none = createOpenClawRuntime({ client: recorder() }).config.watchAdoption();
  assert.equal(none.watching, false);
});

test("agent, file and config views reach only the client they captured", async () => {
  // The client the supervisor replaced and closed (runtime-supervisor.js launch/stop).
  const old = new GatewayClient({
    url: "wss://127.0.0.1:1",
    token: "t",
    certPath: "/nonexistent",
  });
  const supervisor = { client: old };
  const runtime = createOpenClawRuntime(supervisor);
  const connection = runtime.host.connection();
  const views = ["agents", "agentFiles", "config"].map((port) =>
    runtime[port].on(connection),
  );
  const [agents, agentFiles, config] = views;
  const fresh = recorder();
  supervisor.client = fresh;
  old.close();
  const closed = await old.call("agents.list", {}).catch((e) => e);
  for (const pending of [
    agents.list(),
    agents.delete({ agentId: "ap-1", deleteFiles: false }),
    agentFiles.get({ agentId: "ap-1", name: "AGENTS.md" }),
    config.get(),
    config.patch({ build: () => ({ patch: { a: 1 } }) }),
  ]) {
    const error = await pending.catch((e) => e);
    assert.deepEqual(
      [error.code, error.status, error.message],
      [closed.code, closed.status, closed.message],
    );
  }
  assert.deepEqual([closed.code, closed.status], ["UNAVAILABLE", 503]);
  assert.deepEqual(fresh.calls, []);
  for (const view of views) {
    assert.ok(Object.isFrozen(view));
    assert.equal(view.on, undefined);
  }
  // Bound to the current connection, a view uses the current client.
  await runtime.config.on(runtime.host.connection()).get();
  assert.deepEqual(fresh.calls, [["config.get", {}]]);
});

test("admission state is the current connection's, read through the agents sub-port", async () => {
  const refusal = { agentId: "ap-a", code: "agent-database-inspection-failed" };
  const failed = { id: "ap-a", admissionRefusal: refusal };
  const client = recorder((method) =>
    method === "agents.list" ? { agents: [failed, { id: "ap-b" }] } : undefined,
  );
  const supervisor = { client };
  assert.equal(await admissionDoneOn(supervisor), false);
  assert.equal(agentDegradedOn(supervisor, "ap-a"), true);
  assert.equal(agentDegradedOn(supervisor, "ap-b"), false);
  const error = Object.assign(new Error("refused"), {
    admissionRefusal: { agentId: "ap-b", code: "agent-database-inspection-failed" },
  });
  assert.deepEqual(noteRefusalOn(supervisor, error), error.admissionRefusal);
  assert.equal(agentDegradedOn(supervisor, "ap-b"), true);
  const view = withAdmission(
    { runtime: supervisor },
    {
      assistants: [{ id: "b", runtimeAgentId: "ap-b" }],
      conversations: [{ id: "c", assistantId: "b" }],
    },
  );
  assert.equal(view.assistants[0].degraded, true);
  assert.equal(view.conversations[0].diagnostic, "AGENT_DEGRADED");
  // A new client starts without refusals; without a supervisor there are none.
  supervisor.client = recorder();
  assert.equal(agentDegradedOn(supervisor, "ap-a"), false);
  assert.equal(agentDegradedOn(undefined, "ap-a"), false);
  assert.deepEqual(noteRefusalOn(undefined, error), error.admissionRefusal);
  assert.equal(noteRefusalOn(undefined, new Error("x")), null);
  assert.equal(await admissionDoneOn(undefined), undefined);
});

test("a pending admission is a wait, any other refusal degrades the agent", () => {
  const supervisor = { client: recorder() };
  const code = (value) => ({ agentId: "ap-a", code: value });
  assert.equal(admittingOn(supervisor, code("agent-database-inspection-pending")), true);
  assert.equal(admittingOn(supervisor, code("agent-database-inspection-failed")), false);
  assert.equal(admittingOn(supervisor, null), false);
  assert.equal(admittingOn(undefined, code("agent-database-inspection-pending")), false);
});
