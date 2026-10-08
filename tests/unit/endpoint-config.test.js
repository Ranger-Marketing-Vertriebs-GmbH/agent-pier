import test from "node:test";
import assert from "node:assert/strict";
import {
  ENDPOINT_PRESETS,
  normalizeEndpointUrl,
  validateEndpoint,
  endpointOrigins,
  endpointTools,
  endpointModel,
  fallbackOutputTokens,
} from "../../server/features/providers/endpoint-config.js";

const base = {
  preset: "ollama",
  openaiBaseUrl: "http://127.0.0.1:11434/v1/",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: false, chatCompletions: true },
  authHeader: null,
  models: [
    {
      modelId: "qwen3-coder:30b",
      label: "Qwen",
      contextTokens: 32768,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
  ],
  lastTest: null,
};

test("normalizes a valid endpoint block", () => {
  const value = validateEndpoint(base);
  assert.equal(value.openaiBaseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(endpointTools(value), ["codex", "claude", "opencode"]);
  assert.deepEqual(endpointOrigins(value), ["http://127.0.0.1:11434"]);
});

test("rejects unsafe or malformed URLs syntactically", () => {
  for (const url of [
    "ftp://host/v1",
    "http://user:pw@host/v1",
    "http://host/v1?x=1",
    "http://host/v1#f",
    "not a url",
    `http://host/${"a".repeat(2050)}`,
  ])
    assert.throws(() => normalizeEndpointUrl(url), { status: 400 }, url);
  assert.equal(normalizeEndpointUrl("", { optional: true }), null);
});

test("rejects forbidden auth headers and bad models", () => {
  for (const authHeader of ["Host", "cookie", "bad header", "x".repeat(65), "a\nb"])
    assert.throws(() => validateEndpoint({ ...base, authHeader }), { status: 400 });
  assert.equal(
    validateEndpoint({ ...base, authHeader: "api-key" }).authHeader,
    "api-key",
  );
  const model = base.models[0];
  for (const models of [
    [model, model],
    [{ ...model, contextTokens: 100 }],
    [{ ...model, contextTokens: 4096, outputTokens: 8192 }],
    [{ ...model, modelId: "/abs/path.gguf" }],
    Array.from({ length: 201 }, (_, i) => ({ ...model, modelId: `m${i}` })),
  ])
    assert.throws(() => validateEndpoint({ ...base, models }), { status: 400 });
  assert.throws(() => validateEndpoint({ ...base, extra: 1 }), { status: 400 });
});

test("clearing the anthropic URL removes the native claude route, auto falls back to the adapter", () => {
  const value = validateEndpoint({ ...base, anthropicBaseUrl: null });
  assert.deepEqual(endpointTools(value), ["codex", "claude", "opencode"]);
  const off = validateEndpoint({
    ...base,
    anthropicBaseUrl: null,
    routing: { claude: "native", codex: "off" },
  });
  assert.deepEqual(endpointTools(off), ["opencode"]);
});

test("model lookup enforces protocol and context", () => {
  const value = validateEndpoint({
    ...base,
    models: [
      ...base.models,
      { ...base.models[0], modelId: "nocontext", contextTokens: null },
    ],
  });
  assert.equal(endpointModel(value, "qwen3-coder:30b", "claude").contextTokens, 32768);
  const noCodex = validateEndpoint({ ...base, routing: { codex: "off" } });
  assert.throws(() => endpointModel(noCodex, "qwen3-coder:30b", "codex"), /Protokoll/);
  assert.throws(() => endpointModel(value, "missing", "claude"), /nicht eingetragen/);
  assert.throws(() => endpointModel(value, "nocontext", "claude"), /Kontextgröße/);
});

test("presets and output fallback", () => {
  assert.equal(ENDPOINT_PRESETS.llamacpp.protocols.chatCompletions, true);
  assert.equal(ENDPOINT_PRESETS.llamacpp.protocols.messages, false);
  assert.equal(fallbackOutputTokens(32768, null), 8192);
  assert.equal(fallbackOutputTokens(1000000, null), 32000);
  assert.equal(fallbackOutputTokens(32768, 4096), 4096);
});

test("validateEndpoint fills routing defaults and keeps adapter settings", () => {
  const withImages = { ...base, models: [{ ...base.models[0], images: true }] };
  const block = validateEndpoint(withImages);
  assert.deepEqual(block.routing, { claude: "auto", codex: "auto", opencode: "auto" });
  assert.deepEqual(block.adapterCapabilities, {});
  assert.equal(block.thinkTagExtraction, false);
  assert.equal(block.models[0].images, true);
  assert.equal(validateEndpoint(base).models[0].images, null);
  assert.deepEqual(
    validateEndpoint({
      ...base,
      adapterCapabilities: { chatCompletions: { streamUsage: null } },
    }).adapterCapabilities,
    { chatCompletions: {} },
  );
  assert.throws(() => validateEndpoint({ ...base, thinkTagExtraction: "yes" }), {
    status: 400,
  });
  assert.throws(
    () => validateEndpoint({ ...base, models: [{ ...base.models[0], images: "x" }] }),
    { status: 400 },
  );
});

test("endpointTools follows the resolved routes", () => {
  const protocols = { messages: false, responses: false, chatCompletions: true };
  const chatOnly = validateEndpoint({ ...base, protocols });
  assert.deepEqual(
    endpointTools(chatOnly),
    ["codex", "claude", "opencode"],
    "auto offers Codex and Claude Code through the adapter",
  );
  const explicit = validateEndpoint({
    ...base,
    protocols,
    routing: { claude: "adapter:chatCompletions", codex: "off" },
  });
  assert.deepEqual(endpointTools(explicit), ["claude", "opencode"]);
  const off = validateEndpoint({
    ...base,
    protocols,
    routing: { claude: "adapter:chatCompletions", codex: "off", opencode: "off" },
  });
  assert.deepEqual(endpointTools(off), ["claude"]);
});
