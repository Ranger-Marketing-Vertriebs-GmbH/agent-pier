// tests/unit/endpoint-routing.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_AUTO_ROUTES,
  resolveRoute,
  toolRoutes,
  validateRouting,
  validateAdapterCapabilities,
  libraryProtocol,
  routeBaseUrl,
  adapterReasoning,
} from "../../server/features/providers/endpoint-routing.js";

const endpoint = (protocols, routing, extra = {}) => ({
  openaiBaseUrl: "https://llm.example/v1",
  anthropicBaseUrl: protocols.messages ? "https://llm.example" : null,
  protocols: { messages: false, responses: false, chatCompletions: false, ...protocols },
  routing: { claude: "auto", codex: "auto", opencode: "auto", ...routing },
  adapterCapabilities: {},
  ...extra,
});

test("PR 2 default: auto resolves native routes only", () => {
  assert.equal(ADAPTER_AUTO_ROUTES, false);
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude"), { mode: "native", source: "messages" });
  assert.deepEqual(resolveRoute(all, "codex"), { mode: "native", source: "responses" });
  const chat = endpoint({ chatCompletions: true });
  assert.equal(resolveRoute(chat, "claude"), null);
  assert.equal(resolveRoute(chat, "codex"), null);
  assert.deepEqual(resolveRoute(chat, "opencode"), {
    mode: "native",
    source: "chatCompletions",
  });
});

test("explicit adapter routes work while auto adapter routes are off", () => {
  const chat = endpoint(
    { chatCompletions: true },
    { claude: "adapter:chatCompletions", codex: "adapter:chatCompletions" },
  );
  assert.deepEqual(resolveRoute(chat, "claude"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex"), {
    mode: "adapter",
    source: "chatCompletions",
  });
});

test("flipping the flag (PR 3) makes auto fall back to Responses > Messages > Chat", () => {
  const on = { adapterAuto: true };
  const chat = endpoint({ chatCompletions: true });
  assert.deepEqual(resolveRoute(chat, "claude", on), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex", on), {
    mode: "adapter",
    source: "chatCompletions",
  });
  const responsesOnly = endpoint({ responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(responsesOnly, "claude", on), {
    mode: "adapter",
    source: "responses",
  });
  const messagesOnly = endpoint({ messages: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(messagesOnly, "codex", on), {
    mode: "adapter",
    source: "messages",
  });
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude", on), {
    mode: "native",
    source: "messages",
  });
});

test("OpenCode auto takes Chat > Responses > Messages through its SDK providers", () => {
  assert.deepEqual(
    resolveRoute(endpoint({ chatCompletions: true, responses: true }), "opencode"),
    { mode: "native", source: "chatCompletions" },
  );
  assert.deepEqual(
    resolveRoute(endpoint({ responses: true, messages: true }), "opencode"),
    { mode: "sdk", source: "responses" },
  );
  assert.deepEqual(resolveRoute(endpoint({ messages: true }), "opencode"), {
    mode: "sdk",
    source: "messages",
  });
});

test("explicit routes resolve only when their source is enabled; off disables the CLI", () => {
  const e = endpoint(
    { chatCompletions: true },
    { claude: "adapter:responses", codex: "off" },
  );
  assert.equal(resolveRoute(e, "claude"), null);
  assert.equal(resolveRoute(e, "codex"), null);
  assert.deepEqual(toolRoutes(e).opencode, { mode: "native", source: "chatCompletions" });
  assert.equal(
    resolveRoute(endpoint({ chatCompletions: true }, { claude: "native" }), "claude"),
    null,
  );
});

test("records without routing behave as auto", () => {
  const legacy = endpoint({ chatCompletions: true, responses: true });
  delete legacy.routing;
  assert.deepEqual(resolveRoute(legacy, "codex"), {
    mode: "native",
    source: "responses",
  });
  assert.equal(resolveRoute(legacy, "claude"), null);
  assert.deepEqual(resolveRoute(legacy, "claude", { adapterAuto: true }), {
    mode: "adapter",
    source: "responses",
  });
});

test("validation rejects unknown values and native sources as adapter sources", () => {
  assert.deepEqual(validateRouting(undefined), {
    claude: "auto",
    codex: "auto",
    opencode: "auto",
  });
  for (const routing of [
    { claude: "adapter:messages" },
    { codex: "adapter:responses" },
    { opencode: "native" },
    { claude: "auto", extra: "auto" },
    { claude: 1 },
    [],
  ])
    assert.throws(() => validateRouting(routing), { status: 400 });
});

test("capabilities: unknown names dropped, invalid values rejected, chat id mapped", () => {
  assert.deepEqual(
    validateAdapterCapabilities({
      chatCompletions: { maxTokensField: "max_completion_tokens", future: 1 },
    }),
    { chatCompletions: { maxTokensField: "max_completion_tokens" } },
  );
  assert.throws(
    () => validateAdapterCapabilities({ chatCompletions: { streamUsage: "yes" } }),
    { status: 400 },
  );
  assert.throws(() => validateAdapterCapabilities({ gemini: {} }), { status: 400 });
  assert.equal(libraryProtocol("chatCompletions"), "chat");
  assert.equal(libraryProtocol("messages"), "messages");
});

test("route base URL and reasoning support follow the source", () => {
  const e = endpoint(
    { messages: true, chatCompletions: true },
    {},
    {
      adapterCapabilities: { chatCompletions: { reasoningEffort: true } },
    },
  );
  assert.equal(
    routeBaseUrl(e, { mode: "adapter", source: "messages" }),
    "https://llm.example",
  );
  assert.equal(
    routeBaseUrl(e, { mode: "adapter", source: "chatCompletions" }),
    "https://llm.example/v1",
  );
  assert.equal(adapterReasoning(e, "messages"), true);
  assert.equal(adapterReasoning(e, "chatCompletions"), true);
  assert.equal(adapterReasoning(endpoint({ responses: true }), "responses"), true);
  assert.equal(
    adapterReasoning(endpoint({ chatCompletions: true }), "chatCompletions"),
    false,
  );
});
