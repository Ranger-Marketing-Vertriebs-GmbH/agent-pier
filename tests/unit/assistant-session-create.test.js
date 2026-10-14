import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { sessionCreateTimeoutMs } from "../../server/features/assistants/gateway-client.js";
import {
  createGatewaySession,
  sessionNotCreated,
} from "../../server/features/assistants/session-create.js";

// Simulated time: sleeping advances the clock at once.
function clock() {
  const c = { at: 0, sleeps: [] };
  c.now = () => c.at;
  c.sleep = async (ms) => {
    c.sleeps.push(ms);
    c.at += ms;
  };
  return c;
}

// As GatewayClient rejects OpenClaw 2026.10.3's answer after its bounded wait for
// the model catalog: no session was created.
const catalogLoading = () =>
  Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
    code: "UNAVAILABLE",
    status: 503,
    answered: true,
    retryable: true,
  });

// As GatewayClient rejects the refusal OpenClaw (2026.9.9 and 2026.10.3) answers when
// it cannot prepare a new session's access facts, before any write: UNAVAILABLE without
// `retryable`, the thrown error's class name kept as `remoteError`.
const storageNotReady = () =>
  Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
    code: "UNAVAILABLE",
    status: 503,
    answered: true,
    remoteError: "SessionMutationFactsUnavailableError",
  });

/** A Gateway answering `catalogLoading` `busy` times after `waitMs` each. */
function loadingGateway(c, { busy = 1, waitMs = 20000, error = catalogLoading } = {}) {
  const g = { creates: [] };
  g.call = async (method, params, options) => {
    if (method === "sessions.messages.subscribe") return {};
    assert.equal(method, "sessions.create");
    g.creates.push({ at: c.at, timeoutMs: options.timeoutMs });
    c.at += waitMs;
    if (g.creates.length <= busy) throw error();
    return { key: `agent:${params.agentId}:main` };
  };
  return g;
}

test("only an answered, retryable UNAVAILABLE proves no session was created", () => {
  assert.equal(sessionNotCreated(catalogLoading()), true);
  for (const error of [
    { ...catalogLoading(), answered: undefined },
    { ...catalogLoading(), retryable: undefined },
    { ...catalogLoading(), code: "TIMEOUT" },
    { ...catalogLoading(), code: "INVALID_REQUEST" },
    undefined,
  ])
    assert.equal(sessionNotCreated(error), false);
});

test("a refusal before session storage is ready also proves no session was created", () => {
  assert.equal(sessionNotCreated(storageNotReady()), true);
  for (const error of [
    { ...storageNotReady(), answered: undefined },
    { ...storageNotReady(), code: "INVALID_REQUEST" },
    { ...storageNotReady(), remoteError: "SessionLabelConflictError" },
    { ...storageNotReady(), remoteError: undefined },
  ])
    assert.equal(sessionNotCreated(error), false);
});

test("a refusal before session storage is ready is retried", async () => {
  const c = clock(),
    g = loadingGateway(c, { error: storageNotReady, waitMs: 0 });
  const created = await createGatewaySession(g, { agentId: "a" }, c);
  assert.equal(created.key, "agent:a:main");
  assert.equal(g.creates.length, 2);
  assert.equal(c.sleeps.length, 1);
});

test("a retryable answer is retried after a short pause within the budget", async () => {
  const c = clock(),
    g = loadingGateway(c);
  const created = await createGatewaySession(g, { agentId: "a" }, c);
  assert.equal(created.key, "agent:a:main");
  assert.equal(g.creates.length, 2);
  assert.equal(c.sleeps.length, 1);
  assert.ok(c.sleeps[0] <= 1000);
  // The first attempt keeps the whole budget; the retry gets what remains.
  assert.equal(g.creates[0].timeoutMs, sessionCreateTimeoutMs);
  assert.equal(g.creates[1].timeoutMs, sessionCreateTimeoutMs - g.creates[1].at);
});

test("retries end with the Gateway's answer when the budget runs out", async () => {
  const c = clock(),
    g = loadingGateway(c, { busy: Infinity });
  await assert.rejects(createGatewaySession(g, { agentId: "a" }, c), sessionNotCreated);
  // A retry with less room than OpenClaw's own 20 s wait could only time out.
  assert.equal(g.creates.length, 2);
  assert.ok(c.at <= sessionCreateTimeoutMs);
});

test("quick retryable answers are retried a bounded number of times", async () => {
  const c = clock(),
    g = loadingGateway(c, { busy: Infinity, waitMs: 0 });
  await assert.rejects(createGatewaySession(g, { agentId: "a" }, c), sessionNotCreated);
  assert.equal(g.creates.length, c.sleeps.length + 1);
  assert.ok(g.creates.length <= 5);
  assert.ok(c.sleeps.every((ms, n) => n === 0 || ms >= c.sleeps[n - 1]));
});

test("other failures are never retried", async () => {
  for (const error of [
    () => Object.assign(Error("timeout"), { code: "TIMEOUT", status: 503 }),
    () => ({ ...catalogLoading(), retryable: undefined }),
    () => ({ ...catalogLoading(), answered: undefined }),
  ]) {
    const c = clock(),
      g = loadingGateway(c, { error });
    await assert.rejects(createGatewaySession(g, { agentId: "a" }, c));
    assert.equal(g.creates.length, 1);
    assert.deepEqual(c.sleeps, []);
  }
});

function service(t, client, c) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-session-create-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runtime = {
    client: { ready: true, subscribe: () => () => {}, call: client.call },
    on() {},
    off() {},
    close: async () => {},
    setState() {},
  };
  const s = new AssistantService({
    store,
    runtime,
    models: { listCapabilities: () => [], resolve: () => ({ release() {} }) },
    config: { apply: async () => {}, reset() {} },
    sessionCreate: { now: c.now, sleep: c.sleep },
  });
  t.after(() => s.close());
  const a = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
  });
  return { s, a, store };
}

test("opening a conversation retries while the model catalog loads", async (t) => {
  const c = clock(),
    g = loadingGateway(c),
    { s, a } = service(t, g, c);
  const conversation = await s.openConversation(a.id);
  assert.equal(conversation.runtimeSessionKey, `agent:${a.runtimeAgentId}:main`);
  assert.equal(g.creates.length, 2);
});

test("opening a conversation reports a catalog that stays unavailable", async (t) => {
  const c = clock(),
    g = loadingGateway(c, { busy: Infinity }),
    { s, a, store } = service(t, g, c);
  await assert.rejects(s.openConversation(a.id), { code: "UNAVAILABLE", status: 503 });
  assert.equal(g.creates.length, 2);
  assert.deepEqual(
    store.listConversations().filter((x) => x.assistantId === a.id),
    [],
  );
});
