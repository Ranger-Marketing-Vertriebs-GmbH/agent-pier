// tests/unit/endpoint-routing.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTER_AUTO_ROUTES,
  ROUTE_MODES,
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

test("auto prefers native routes and falls back to the adapter", () => {
  assert.equal(ADAPTER_AUTO_ROUTES, true);
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude"), { mode: "native", source: "messages" });
  assert.deepEqual(resolveRoute(all, "codex"), { mode: "native", source: "responses" });
  const chat = endpoint({ chatCompletions: true });
  assert.deepEqual(resolveRoute(chat, "claude"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "opencode"), {
    mode: "native",
    source: "chatCompletions",
  });
});

test("the adapterAuto seam still turns the fallback off", () => {
  const chat = endpoint({ chatCompletions: true });
  assert.equal(resolveRoute(chat, "claude", { adapterAuto: false }), null);
  assert.equal(resolveRoute(chat, "codex", { adapterAuto: false }), null);
});

test("explicit adapter routes resolve to their source", () => {
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

test("auto falls back in the order Responses > Messages > Chat", () => {
  const chat = endpoint({ chatCompletions: true });
  assert.deepEqual(resolveRoute(chat, "claude"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(resolveRoute(chat, "codex"), {
    mode: "adapter",
    source: "chatCompletions",
  });
  const responsesOnly = endpoint({ responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(responsesOnly, "claude"), {
    mode: "adapter",
    source: "responses",
  });
  const messagesOnly = endpoint({ messages: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(messagesOnly, "codex"), {
    mode: "adapter",
    source: "messages",
  });
  const all = endpoint({ messages: true, responses: true, chatCompletions: true });
  assert.deepEqual(resolveRoute(all, "claude"), {
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
  assert.deepEqual(resolveRoute(legacy, "claude"), {
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

test("explicit OpenCode choices: sdk for Messages/Responses, null for disabled sources", () => {
  const all = { messages: true, responses: true, chatCompletions: true };
  assert.deepEqual(resolveRoute(endpoint(all, { opencode: "responses" }), "opencode"), {
    mode: "sdk",
    source: "responses",
  });
  assert.deepEqual(resolveRoute(endpoint(all, { opencode: "messages" }), "opencode"), {
    mode: "sdk",
    source: "messages",
  });
  assert.deepEqual(
    resolveRoute(endpoint(all, { opencode: "chatCompletions" }), "opencode"),
    { mode: "native", source: "chatCompletions" },
  );
  assert.equal(
    resolveRoute(
      endpoint({ chatCompletions: true }, { opencode: "responses" }),
      "opencode",
    ),
    null,
  );
});

test("legacy Responses-only and Messages-only records resolve OpenCode sdk routes", () => {
  const responses = endpoint({ responses: true });
  delete responses.routing;
  assert.deepEqual(toolRoutes(responses).opencode, { mode: "sdk", source: "responses" });
  const messages = endpoint({ messages: true });
  delete messages.routing;
  assert.deepEqual(toolRoutes(messages).opencode, { mode: "sdk", source: "messages" });
});

test("route modes are the three launch strategies", () => {
  assert.deepEqual([...ROUTE_MODES], ["native", "adapter", "sdk"]);
});

test("null and non-object inputs", () => {
  assert.deepEqual(validateRouting(null), {
    claude: "auto",
    codex: "auto",
    opencode: "auto",
  });
  assert.deepEqual(validateAdapterCapabilities(null), {});
  assert.deepEqual(validateAdapterCapabilities(undefined), {});
  for (const bad of [{ chatCompletions: "x" }, { chatCompletions: null }, [], "x"])
    assert.throws(() => validateAdapterCapabilities(bad), { status: 400 });
});
