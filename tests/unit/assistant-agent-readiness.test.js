import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import {
  GatewayClient,
  agentCreateTimeoutMs,
  sessionCreateTimeoutMs,
} from "../../server/features/assistants/gateway-client.js";
import {
  agentRosterTimeoutMs,
  waitForAgentInRoster,
} from "../../server/features/assistants/openclaw-config/agent-roster.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { gatewayFixture } from "../helpers/assistant-gateway-fixture.js";

// Simulated time: sleeping advances the clock at once, so seconds cost nothing.
function clock() {
  const c = { at: 0, sleeps: [] };
  c.now = () => c.at;
  c.sleep = async (ms) => {
    c.sleeps.push(ms);
    c.at += ms;
  };
  return c;
}

/**
 * A Gateway whose plugin reload after agents.create takes `reloadMs` of simulated
 * time: until then agents.list answers UNAVAILABLE (as OpenClaw does while its
 * plugins reload) or, with `omit`, a roster without the new agent.
 */
function slowGateway(c, { reloadMs = Infinity, omit = false } = {}) {
  const g = { lists: 0, createdAt: null, id: null };
  g.call = async (method, params) => {
    if (method === "agents.create") {
      g.createdAt = c.now();
      g.id = params.name;
      return { agentId: params.name };
    }
    if (method === "agents.list") {
      g.lists++;
      const loaded = g.createdAt !== null && c.now() - g.createdAt >= reloadMs;
      if (loaded) return { agents: [{ id: g.id }] };
      if (g.createdAt !== null && !omit)
        throw Object.assign(Error("Plugin openai was reloaded"), {
          code: "UNAVAILABLE",
          answered: true,
        });
      return { agents: [] };
    }
    if (method === "agents.update" || method === "agents.files.set") return {};
    if (method === "agents.files.get") return { file: { missing: true } };
    if (method === "config.get")
      return { config: { agents: { entries: { [g.id]: { model: "new/model" } } } } };
    assert.fail(method);
  };
  return g;
}

test("a new agent that the Gateway lists only after 8 s is still applied", async (t) => {
  const c = clock();
  const gateway = slowGateway(c, { reloadMs: 8000 });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-roster-slow-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const bootstrap = [];
  const creates = [];
  const config = new AssistantConfig({
    store,
    client: {
      call: async (method, params, options) => {
        if (method === "agents.create") creates.push(options?.timeoutMs);
        if (method === "agents.files.set" && params.name === "AGENTS.md")
          bootstrap.push(params.content);
        const result = await gateway.call(method, params);
        if (method === "agents.files.get")
          return params.name === "AGENTS.md" && bootstrap.length
            ? { file: { content: bootstrap.at(-1) } }
            : { file: { missing: true } };
        return result;
      },
    },
    workspaces: dataDir,
    models: { resolve: () => ({ modelRef: "new/model", display: "m", release() {} }) },
    roster: { now: c.now, sleep: c.sleep, warn: () => assert.fail("warned") },
  });
  await config.apply(a.id);
  assert.equal(store.getAssistant(a.id).effectiveRevision, 1);
  // agents.create gets its own budget: 2026.10.7 needed more than the default 10 s
  // for a fresh install's first agent on a slow Intel Mac.
  assert.deepEqual(creates, [agentCreateTimeoutMs]);
  assert.equal(agentCreateTimeoutMs, 30000);
  // Listed after the reload, not earlier: the old 50 x 100 ms budget ended at 5 s.
  assert.ok(c.at >= 8000 && c.at < 9000, String(c.at));
  // The pause grows to one second, so a long reload costs few roster reads.
  assert.ok(gateway.lists <= 15, String(gateway.lists));
  assert.equal(Math.max(...c.sleeps), 1000);
});

test("an agent the Gateway never lists fails clearly at the deadline", async () => {
  for (const omit of [false, true]) {
    const c = clock();
    const gateway = slowGateway(c, { omit });
    await gateway.call("agents.create", { name: "home" });
    const warnings = [];
    await assert.rejects(
      waitForAgentInRoster(gateway, "home", {
        now: c.now,
        sleep: c.sleep,
        warn: (line) => warnings.push(line),
      }),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.key, "agentLoading");
        assert.equal(error.message, serverMessages.assistants.agentLoading);
        return true;
      },
    );
    // Neither earlier nor later than the deadline, with one last read at it.
    assert.equal(c.at, agentRosterTimeoutMs);
    assert.ok(agentRosterTimeoutMs >= 30000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /within 30000 ms/);
  }
});

test("a lost connection or a call timeout during the roster wait fails at once", async () => {
  for (const failure of [{ code: "UNAVAILABLE" }, { code: "TIMEOUT" }]) {
    const c = clock();
    const client = {
      call: async () => {
        throw Object.assign(Error(failure.code), failure);
      },
    };
    await assert.rejects(
      waitForAgentInRoster(client, "home", { now: c.now, sleep: c.sleep }),
      { message: failure.code },
    );
    assert.equal(c.at, 0);
  }
});

test("a call's own timeout outlasts the client default", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  // Connected with the normal timeout on real timers; the calls below run on mocked
  // ones, so a slow host cannot fire or skip a timeout early.
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  await client.connect();
  client.timeoutMs = 100;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const watch = (promise) => {
    const state = { settled: false, error: null };
    promise.catch((error) => {
      state.settled = true;
      state.error = error;
    });
    return state;
  };
  // The fixture never answers "pending"; only the timers end these calls.
  const short = watch(client.call("pending", {}));
  const long = watch(client.call("pending", {}, { timeoutMs: 600 }));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  await settle();
  assert.equal(short.error?.code, "TIMEOUT", "the default ends at 100 ms");
  assert.equal(long.settled, false, "the call's own 600 ms still runs");
  t.mock.timers.tick(499);
  await settle();
  assert.equal(long.settled, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(long.error?.code, "TIMEOUT");
});

// AGENTPIER-50: the first sessions.create of a Gateway process loads its session
// handlers cold and took over 10 s on Intel macOS runners.
test("opening a conversation gives a cold first sessions.create its own timeout", async (t) => {
  assert.ok(sessionCreateTimeoutMs >= 60000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-create-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  const creates = [];
  const client = {
    ready: true,
    subscribe: () => () => {},
    // As GatewayClient: the default 10 s, unless the call names its own.
    call: async (method, params, { timeoutMs = 10000 } = {}) => {
      if (method === "sessions.create") {
        creates.push(timeoutMs);
        if (timeoutMs < 12000) throw Object.assign(Error("timeout"), { code: "TIMEOUT" });
        return { key: `agent:${params.agentId}:main` };
      }
      if (method === "sessions.messages.subscribe") return {};
      assert.fail(method);
    },
  };
  const runtime = { client, on() {}, off() {}, close: async () => {}, setState() {} };
  const service = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
  });
  t.after(() => service.close());
  const conversation = await service.openConversation(a.id);
  assert.equal(conversation.runtimeSessionKey, `agent:${a.runtimeAgentId}:main`);
  assert.deepEqual(creates, [sessionCreateTimeoutMs]);
});
