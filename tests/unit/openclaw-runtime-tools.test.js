import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { backgroundMethod } from "../../server/features/assistants/team-plugin/background-commands.js";
import {
  chatTitleMethod,
  titleTimeoutMs,
} from "../../server/features/assistants/team-plugin/chat-title.js";
import {
  memoryReviewMethod,
  memoryReviewTimeoutMs,
} from "../../server/features/assistants/team-plugin/memory-review.js";

// A client that records each call and request as [method, params, options?] and
// answers `answer(method, params)`.
function recorder(answer = () => ({})) {
  const client = new EventEmitter();
  return Object.assign(client, {
    calls: [],
    ready: true,
    async call(method, ...rest) {
      client.calls.push([method, ...rest]);
      return answer(method, rest[0]);
    },
    async request(method, ...rest) {
      client.calls.push(["request", method, ...rest]);
      return answer(method, rest[0]);
    },
    openStream(path) {
      client.calls.push(["openStream", path]);
      return { path };
    },
  });
}

test("skills, browser and models send the Gateway requests callers sent before the port", async () => {
  const client = recorder();
  const { skills, browser, models } = createOpenClawRuntime({ client });
  await skills.status({ agentId: "ap-1" });
  await skills.status();
  const query = { profile: "agentpier-ap-1" };
  await browser.request({ method: "POST", path: "/start", query, timeoutMs: 30000 });
  await browser.request({ method: "GET", path: "/", query });
  await browser.request({ method: "POST", path: "/screencast", query, body: { q: 1 } });
  assert.deepEqual(browser.openStream({ path: "/ws/1" }), { path: "/ws/1" });
  await models.catalog({ provider: "openai", refresh: true, timeoutMs: 5 });
  await models.catalog({ provider: "openai", refresh: false, timeoutMs: 6 });
  await models.status({ timeoutMs: 60000 });
  await models.probe({
    provider: "openai",
    profileId: "p1",
    probeTimeoutMs: 15000,
    timeoutMs: 20000,
  });
  await models.logout({ provider: "openai", profileIds: ["p1"], timeoutMs: 60000 });
  await models.login({ sessionId: "s1", authChoice: "openai/x", timeoutMs: 60000 });
  await models.loginStep({ sessionId: "s1", timeoutMs: 7 });
  await models.loginStep({ sessionId: "s1", answer: { stepId: "a" }, timeoutMs: 8 });
  await models.cancelLogin({ sessionId: "s1", timeoutMs: 2000 });
  assert.deepEqual(client.calls, [
    ["skills.status", { agentId: "ap-1" }],
    ["skills.status", {}],
    [
      "request",
      "browser.request",
      { method: "POST", path: "/start", query },
      { timeoutMs: 30000 },
    ],
    ["request", "browser.request", { method: "GET", path: "/", query }],
    [
      "request",
      "browser.request",
      { method: "POST", path: "/screencast", query, body: { q: 1 } },
    ],
    ["openStream", "/ws/1"],
    [
      "models.list",
      { agentId: "main", provider: "openai", view: "all", refresh: true },
      { timeoutMs: 5 },
    ],
    [
      "models.list",
      { agentId: "main", provider: "openai", view: "all" },
      { timeoutMs: 6 },
    ],
    ["models.authStatus", { agentId: "main" }, { timeoutMs: 60000 }],
    [
      "models.probe",
      { provider: "openai", agentId: "main", profileId: "p1", timeoutMs: 15000 },
      { timeoutMs: 20000 },
    ],
    [
      "models.authLogout",
      { provider: "openai", agentId: "main", profileIds: ["p1"] },
      { timeoutMs: 60000 },
    ],
    [
      "models.authLogin",
      { sessionId: "s1", agentId: "main", authChoice: "openai/x" },
      { timeoutMs: 60000 },
    ],
    ["wizard.next", { sessionId: "s1" }, { timeoutMs: 7 }],
    ["wizard.next", { sessionId: "s1", answer: { stepId: "a" } }, { timeoutMs: 8 }],
    ["wizard.cancel", { sessionId: "s1", closeInput: true }, { timeoutMs: 2000 }],
  ]);
});

test("skills.unknownAgent tells only OpenClaw's unknown agent refusal", () => {
  const { skills } = createOpenClawRuntime({ client: null });
  const refusal = (code, remoteMessage) =>
    Object.assign(new Error("x"), { code, remoteMessage });
  assert.equal(
    skills.unknownAgent(refusal("INVALID_REQUEST", 'unknown agent id "ap-1"')),
    true,
  );
  assert.equal(skills.unknownAgent(refusal("INVALID_REQUEST", "bad params")), false);
  assert.equal(skills.unknownAgent(refusal("UNAVAILABLE", "unknown agent")), false);
  assert.equal(skills.unknownAgent(undefined), false);
});

test("the team plugin's background and title calls go through sessions", async () => {
  const answers = [{ running: 0, completing: 1 }, { running: 0 }, null, { title: "T" }];
  const client = recorder(() => answers.shift());
  const { sessions } = createOpenClawRuntime({ client });
  assert.equal(await sessions.backgroundRunning({ key: "agent:a:main" }), true);
  assert.equal(await sessions.backgroundRunning({ key: "agent:a:main" }), false);
  assert.equal(await sessions.backgroundRunning({ key: "agent:a:main" }), false);
  assert.deepEqual(await sessions.title({ agentId: "ap-1", message: "m", reply: "r" }), {
    title: "T",
  });
  assert.deepEqual(client.calls, [
    [backgroundMethod, { sessionKey: "agent:a:main" }],
    [backgroundMethod, { sessionKey: "agent:a:main" }],
    [backgroundMethod, { sessionKey: "agent:a:main" }],
    [
      chatTitleMethod,
      { agentId: "ap-1", message: "m", reply: "r" },
      { timeoutMs: titleTimeoutMs + 5000 },
    ],
  ]);
});

test("the memory review is the team plugin's method on the agent's model", async () => {
  const client = recorder(() => ({ text: "[]" }));
  const { sessions } = createOpenClawRuntime({ client });
  const review = { agentId: "ap-1", instructions: "Review.", input: "=== MEMORY.md" };
  assert.deepEqual(await sessions.reviewMemory(review), { text: "[]" });
  assert.deepEqual(client.calls, [
    [memoryReviewMethod, review, { timeoutMs: memoryReviewTimeoutMs + 5000 }],
  ]);
});

test("host.connected and onDisconnect follow the client behind a connection", () => {
  const client = recorder();
  const supervisor = { client };
  const { host } = createOpenClawRuntime(supervisor);
  const connection = host.connection();
  assert.equal(host.connected(connection), true);
  const heard = [];
  const unsubscribe = host.onDisconnect(connection, () => heard.push("lost"));
  client.emit("disconnected");
  client.emit("disconnected");
  assert.deepEqual(heard, ["lost"]);
  host.onDisconnect(connection, () => heard.push("again"));
  unsubscribe();
  client.ready = false;
  assert.equal(host.connected(connection), false);
  // A replaced client stays reachable through its handle, never the new one's.
  supervisor.client = recorder();
  assert.notEqual(host.connection(), connection);
  assert.equal(host.connected(host.connection()), true);
  assert.equal(host.connected(connection), false);
  const late = host.onDisconnect(connection, () => heard.push("late"));
  late();
  client.emit("disconnected");
  assert.deepEqual(heard, ["lost", "again"]);
  assert.equal(host.connected(null), false);
  assert.equal(typeof host.onDisconnect(null, () => {}), "function");
});

test("skills, browser and models views reach only the client they captured", async () => {
  // The client the supervisor replaced and closed (runtime-supervisor.js launch/stop).
  const old = new GatewayClient({
    url: "wss://127.0.0.1:1",
    token: "t",
    certPath: "/nonexistent",
  });
  const supervisor = { client: old };
  const runtime = createOpenClawRuntime(supervisor);
  const connection = runtime.host.connection();
  const [skills, browser, models] = ["skills", "browser", "models"].map((port) =>
    runtime[port].on(connection),
  );
  const fresh = recorder();
  supervisor.client = fresh;
  old.close();
  const closed = await old.call("skills.status", {}).catch((e) => e);
  for (const pending of [
    skills.status({ agentId: "ap-1" }),
    browser.request({ method: "GET", path: "/", query: {} }),
    models.catalog({ provider: "openai", timeoutMs: 1 }),
    models.status({ timeoutMs: 1 }),
    models.probe({ provider: "openai", profileId: "p", timeoutMs: 1 }),
    models.logout({ provider: "openai", profileIds: [], timeoutMs: 1 }),
    models.login({ sessionId: "s", authChoice: "x", timeoutMs: 1 }),
    models.loginStep({ sessionId: "s", timeoutMs: 1 }),
    models.cancelLogin({ sessionId: "s", timeoutMs: 1 }),
  ]) {
    const error = await pending.catch((e) => e);
    assert.deepEqual(
      [error.code, error.status, error.message],
      [closed.code, closed.status, closed.message],
    );
  }
  assert.deepEqual(fresh.calls, []);
  for (const view of [skills, browser, models]) {
    assert.ok(Object.isFrozen(view));
    assert.equal(view.on, undefined);
  }
  await runtime.skills.on(runtime.host.connection()).status();
  assert.deepEqual(fresh.calls, [["skills.status", {}]]);
});
