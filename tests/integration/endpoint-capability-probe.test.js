import test from "node:test";
import assert from "node:assert/strict";
import { fakeEndpoint } from "../helpers/endpoint-servers.js";
import { runEndpointTest } from "../../server/features/providers/endpoint-probe.js";
import { probeCapabilities } from "../../server/features/providers/endpoint-capability-probe.js";

const OK_CHAT = {
  json: { id: "c", choices: [{ message: { role: "assistant", content: "ok" } }] },
};
const OK_RESPONSES = { json: { id: "r", object: "response", output: [] } };
const OK_MESSAGES = { json: { id: "m", type: "message", content: [] } };
const REFUSE = { status: 400, json: { error: { message: "SECRET upstream text" } } };

const draft = (base) => ({
  preset: "custom",
  openaiBaseUrl: `${base}/v1`,
  anthropicBaseUrl: base,
  authHeader: null,
});
const run = (base, extra = {}) =>
  runEndpointTest({
    endpoint: draft(base),
    apiKey: "sk-secret",
    probeModelId: "m1",
    previousModels: [],
    ...extra,
  });
const rejecting =
  (predicate, ok) =>
  ({ body }) =>
    predicate(body) ? REFUSE : ok;
const midSystem = (body) => body.messages?.slice(1).some((m) => m.role === "system");

test("chat probe proposes values from per-parameter answers", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/chat/completions": rejecting(
      (body) => "reasoning_effort" in body || midSystem(body),
      OK_CHAT,
    ),
  });
  const result = await run(server.base);
  assert.deepEqual(result.capabilities.chatCompletions, {
    streamUsage: true,
    reasoningEffort: false,
    promptCacheKey: true,
    parallelToolCalls: true,
    systemMessages: "merge",
  });
  const chat = server.seen.filter((e) => e.url === "/v1/chat/completions");
  assert.equal(chat.length, 1 + 5);
  assert.ok(chat.slice(1).every((e) => e.body.max_tokens === 16));
});

test("chat probe reports max_completion_tokens when the base request is refused", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/chat/completions": rejecting((body) => "max_tokens" in body, OK_CHAT),
  });
  const result = await run(server.base);
  assert.equal(result.protocols.chatCompletions, "ok");
  assert.deepEqual(result.capabilities.chatCompletions, {
    maxTokensField: "max_completion_tokens",
    streamUsage: true,
    reasoningEffort: true,
    promptCacheKey: true,
    parallelToolCalls: true,
    systemMessages: "inline",
  });
  const chat = server.seen.filter((e) => e.url === "/v1/chat/completions");
  assert.equal(chat.length, 1 + 1 + 5);
  assert.ok(chat.slice(1).every((e) => e.body.max_completion_tokens === 16));
  assert.ok(chat.slice(1).every((e) => !("max_tokens" in e.body)));
});

test("a server rejecting both token fields gets no chat entry and no further probes", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/chat/completions": () => REFUSE,
  });
  const result = await run(server.base);
  assert.equal(result.capabilities.chatCompletions, undefined);
  assert.equal(server.seen.filter((e) => e.url === "/v1/chat/completions").length, 2);
});

test("responses probe rejects reasoning and accepts the rest", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/responses": rejecting((body) => "reasoning" in body, OK_RESPONSES),
  });
  const result = await run(server.base);
  assert.deepEqual(result.capabilities.responses, {
    reasoningEffort: false,
    promptCacheKey: true,
    parallelToolCalls: true,
  });
  assert.equal(server.seen.filter((e) => e.url === "/v1/responses").length, 1 + 3);
});

test("messages probe falls back from adaptive to an enabled budget", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/messages": rejecting(
      (body) => body.thinking?.type === "adaptive" || !!body.system,
      OK_MESSAGES,
    ),
  });
  const result = await run(server.base);
  assert.deepEqual(result.capabilities.messages, {
    promptCache: false,
    thinkingBudget: true,
  });
  const seen = server.seen.filter((e) => e.url === "/v1/messages");
  assert.equal(seen.length, 1 + 3);
  assert.deepEqual(seen.at(-1).body.thinking, { type: "enabled", budget_tokens: 1024 });
  assert.equal(seen.at(-1).body.max_tokens, 1025);
});

test("messages probe omits thinkingBudget when neither thinking form is accepted", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/messages": rejecting((body) => !!body.thinking, OK_MESSAGES),
  });
  const result = await run(server.base);
  assert.deepEqual(result.capabilities.messages, { promptCache: true });
});

test("a 401 omits the key; a hanging request ends at timeoutMs and omits it", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/chat/completions": ({ body }) =>
      body.reasoning_effort
        ? { status: 401, json: {} }
        : body.prompt_cache_key
          ? "hang"
          : OK_CHAT,
  });
  const endpoint = draft(server.base);
  const results = { chatCompletions: { status: 200, json: {} } };
  const capabilities = await probeCapabilities({
    endpoint,
    apiKey: "",
    model: "m1",
    results,
    timeoutMs: 100,
  });
  assert.deepEqual(capabilities.chatCompletions, {
    streamUsage: true,
    parallelToolCalls: true,
    systemMessages: "inline",
  });
});

test("failed or skipped base protocols have no entry and no extra requests", async (t) => {
  const server = await fakeEndpoint(t, {});
  const result = await run(server.base);
  assert.deepEqual(result.capabilities, {});
  assert.equal(server.seen.filter((e) => e.method === "POST").length, 3);
});

test("results carry no upstream text or keys", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /v1/chat/completions": rejecting((body) => "reasoning_effort" in body, OK_CHAT),
    "POST /v1/responses": () => REFUSE,
  });
  const result = await run(server.base);
  const text = JSON.stringify(result);
  assert.ok(!text.includes("SECRET"));
  assert.ok(!text.includes("sk-secret"));
});
