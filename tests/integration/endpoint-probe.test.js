import test from "node:test";
import assert from "node:assert/strict";
import {
  fakeEndpoint,
  ollamaRoutes,
  llamaRoutes,
  azureRoutes,
} from "../helpers/endpoint-servers.js";
import { listEndpointModels } from "../../server/features/providers/endpoint-models.js";
import { endpointRequest } from "../../server/features/providers/endpoint-http.js";
import {
  classifyProbe,
  runEndpointTest,
} from "../../server/features/providers/endpoint-probe.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";

const draft = (base, preset, extra = {}) => ({
  preset,
  openaiBaseUrl: `${base}/v1`,
  anthropicBaseUrl: base,
  authHeader: null,
  ...extra,
});

test("ollama listing reads num_ctx and keeps model maximum only as hint", async (t) => {
  const server = await fakeEndpoint(t, ollamaRoutes());
  const result = await listEndpointModels({
    endpoint: draft(server.base, "ollama"),
    apiKey: "",
  });
  assert.equal(result.listed, true);
  assert.deepEqual(
    result.models.map(({ modelId, contextTokens, contextHint }) => ({
      modelId,
      contextTokens,
      contextHint,
    })),
    [
      { modelId: "qwen3:8b", contextTokens: 40960, contextHint: 262144 },
      { modelId: "llama3:8b", contextTokens: null, contextHint: 131072 },
    ],
  );
  assert.ok(result.warnings.includes("ollamaContextUnknown"));
});

test("native Ollama and llama.cpp routes follow the OpenAI URL, not a stale Anthropic URL", async (t) => {
  const stale = await fakeEndpoint(t, {});
  const ollama = await fakeEndpoint(t, ollamaRoutes());
  const detected = await listEndpointModels({
    endpoint: draft(ollama.base, "ollama", { anthropicBaseUrl: stale.base }),
    apiKey: "",
  });
  assert.equal(detected.models[0].contextTokens, 40960);
  const llama = await fakeEndpoint(t, llamaRoutes());
  const single = await listEndpointModels({
    endpoint: draft(llama.base, "llamacpp", { anthropicBaseUrl: stale.base }),
    apiKey: "",
  });
  assert.deepEqual(
    single.models.map((m) => [m.modelId, m.contextTokens]),
    [["coder", 32768]],
  );
  assert.equal(stale.seen.length, 0);
});

test("llama.cpp single and router mode", async (t) => {
  const single = await fakeEndpoint(t, llamaRoutes());
  const one = await listEndpointModels({
    endpoint: draft(single.base, "llamacpp"),
    apiKey: "",
  });
  assert.deepEqual(
    one.models.map((m) => [m.modelId, m.contextTokens]),
    [["coder", 32768]],
  );
  assert.ok(one.warnings.includes("modelIdSkipped"));
  assert.ok(!single.seen.some((entry) => entry.url.includes("model=")));
});

test("llama.cpp router detection never loads a model", async (t) => {
  const loads = [];
  const router = await fakeEndpoint(t, llamaRoutes({ router: true, loads }));
  const many = await listEndpointModels({
    endpoint: draft(router.base, "llamacpp"),
    apiKey: "",
  });
  assert.deepEqual(
    many.models.map((m) => [m.modelId, m.contextTokens]),
    [
      ["coder", 32768],
      ["small", 8192],
      ["big", null],
    ],
  );
  assert.deepEqual(loads, []);
  const props = router.seen.filter((entry) => entry.url.startsWith("/props"));
  assert.deepEqual(
    props.map((entry) => entry.url),
    ["/props?model=coder&autoload=false"],
  );
  const one = await fakeEndpoint(
    t,
    llamaRoutes({ router: true, models: ["coder"], loads }),
  );
  const alone = await listEndpointModels({
    endpoint: draft(one.base, "llamacpp"),
    apiKey: "",
  });
  assert.deepEqual(
    alone.models.map((m) => [m.modelId, m.contextTokens]),
    [["coder", 32768]],
  );
  assert.deepEqual(loads, []);
});

test("azure-like listing uses the custom header and never echoes bodies", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const endpoint = {
    preset: "custom",
    openaiBaseUrl: `${server.base}/openai/v1`,
    anthropicBaseUrl: null,
    authHeader: "api-key",
  };
  const result = await listEndpointModels({ endpoint, apiKey: "az-key" });
  assert.deepEqual(
    result.models.map((m) => m.modelId),
    ["gpt-4.1"],
  );
  assert.equal(server.seen[0].headers["api-key"], "az-key");
  assert.equal(server.seen[0].headers.authorization, undefined);
});

test("client enforces redirect, size and timeout limits", async (t) => {
  const server = await fakeEndpoint(t, {
    "GET /redirect": () => ({
      status: 302,
      headers: { location: "http://127.0.0.1:1/" },
      json: {},
    }),
    "GET /big": () => ({ raw: "x".repeat(1024 * 1024 + 10) }),
    "GET /hang": () => "hang",
  });
  assert.equal(
    (await endpointRequest({ url: `${server.base}/redirect`, timeoutMs: 2000 })).status,
    302,
  );
  await assert.rejects(endpointRequest({ url: `${server.base}/big`, timeoutMs: 2000 }), {
    reason: "tooLarge",
  });
  await assert.rejects(endpointRequest({ url: `${server.base}/hang`, timeoutMs: 200 }), {
    reason: "timeout",
  });
  await assert.rejects(
    endpointRequest({ url: "http://8.8.8.8/v1/models", timeoutMs: 200 }),
    { reason: "notAllowed" },
  );
});

test("pinned lookup is used for hostnames", async (t) => {
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: [] } }),
  });
  const port = new URL(server.base).port;
  const calls = [];
  const lookup = async (host) => (
    calls.push(host),
    [{ address: "127.0.0.1", family: 4 }]
  );
  const result = await endpointRequest({
    url: `http://model.test:${port}/v1/models`,
    timeoutMs: 2000,
    lookup,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["model.test"]);
  assert.equal(server.seen[0].headers.host, `model.test:${port}`);
});

test("probe classification distinguishes missing protocol from missing model", () => {
  assert.deepEqual(classifyProbe({ status: 200, json: {} }, { listedModel: true }), {
    status: "ok",
  });
  assert.deepEqual(classifyProbe({ status: 404, json: {} }, { listedModel: true }), {
    status: "unsupported",
    reason: "notFound",
  });
  assert.deepEqual(classifyProbe({ status: 404, json: {} }, { listedModel: false }), {
    status: "failed",
    reason: "modelNotFound",
  });
  assert.deepEqual(classifyProbe({ status: 400, json: {} }, { listedModel: true }), {
    status: "ok",
    warning: "rejectedRequest",
  });
  assert.deepEqual(classifyProbe({ status: 401, json: {} }, { listedModel: true }), {
    status: "failed",
    reason: "auth",
  });
  assert.deepEqual(classifyProbe({ status: 302, json: null }, { listedModel: true }), {
    status: "failed",
    reason: "http",
  });
  assert.deepEqual(classifyProbe({ status: 200, json: null }, { listedModel: true }), {
    status: "failed",
    reason: "invalidResponse",
  });
  assert.deepEqual(classifyProbe({ reason: "timeout" }, { listedModel: true }), {
    status: "failed",
    reason: "timeout",
  });
});

test("ollama test proposes all protocols", async (t) => {
  const server = await fakeEndpoint(t, ollamaRoutes());
  const result = await runEndpointTest({
    endpoint: draft(server.base, "ollama"),
    apiKey: "",
    previousModels: [],
  });
  assert.equal(result.probeModelId, "qwen3:8b");
  assert.deepEqual(result.protocols, {
    messages: "ok",
    responses: "ok",
    chatCompletions: "ok",
  });
});

test("llama.cpp without messages route reports unsupported", async (t) => {
  const server = await fakeEndpoint(t, llamaRoutes());
  const result = await runEndpointTest({
    endpoint: draft(server.base, "llamacpp"),
    apiKey: "",
    previousModels: [],
  });
  assert.deepEqual(result.protocols, {
    messages: "unsupported",
    responses: "unsupported",
    chatCompletions: "ok",
  });
});

test("azure manual deployment: 404 on unlisted model is modelNotFound, 400 is rejectedRequest", async (t) => {
  const server = await fakeEndpoint(t, azureRoutes("az-key"));
  const endpoint = {
    preset: "custom",
    openaiBaseUrl: `${server.base}/openai/v1`,
    anthropicBaseUrl: null,
    authHeader: "api-key",
  };
  const manual = [
    {
      modelId: "my-deploy",
      label: "my-deploy",
      contextTokens: 128000,
      outputTokens: null,
      source: "manual",
      contextEdited: true,
    },
  ];
  const result = await runEndpointTest({
    endpoint,
    apiKey: "az-key",
    previousModels: manual,
    probeModelId: "my-deploy",
  });
  assert.deepEqual(result.protocols, {
    messages: "skipped",
    responses: "ok",
    chatCompletions: "ok",
  });
  assert.ok(result.warnings.includes("rejectedRequest"));
  assert.ok(
    result.models.some(
      (model) => model.modelId === "my-deploy" && model.source === "manual",
    ),
  );
  const wrong = await runEndpointTest({
    endpoint,
    apiKey: "az-key",
    previousModels: manual,
    probeModelId: "gpt-4.1",
  });
  assert.equal(wrong.protocols.responses, "unsupported"); // gpt-4.1 was listed, so 404 means unsupported
});

test("a long listing plus manual models stays saveable and warns", async (t) => {
  const ids = Array.from({ length: 205 }, (_, index) => `m-${index}`);
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: ids.map((id) => ({ id })) } }),
    "POST /v1/chat/completions": () => ({ json: { choices: [] } }),
  });
  const manual = {
    modelId: "my-deploy",
    label: "my-deploy",
    contextTokens: 128000,
    outputTokens: null,
    source: "manual",
    contextEdited: true,
  };
  const result = await runEndpointTest({
    endpoint: { ...draft(server.base, "custom"), anthropicBaseUrl: null },
    apiKey: "",
    previousModels: [manual],
  });
  assert.equal(result.models.length, 200);
  assert.ok(result.models.some((model) => model.modelId === "my-deploy"));
  assert.ok(result.warnings.includes("modelListTruncated"));
  assert.doesNotThrow(() =>
    validateEndpoint({
      preset: "custom",
      openaiBaseUrl: `${server.base}/v1`,
      anthropicBaseUrl: null,
      protocols: { messages: false, responses: false, chatCompletions: true },
      authHeader: null,
      models: result.models,
      lastTest: null,
    }),
  );
});

test("a 404 is a missing protocol when another protocol accepted the same model", async (t) => {
  // llama-server started with -m <path>: the listed ID is skipped, any model name works.
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: [{ id: "/models/q.gguf" }] } }),
    "POST /v1/chat/completions": () => ({ json: { choices: [] } }),
  });
  const manual = [
    {
      modelId: "qwen",
      label: "qwen",
      contextTokens: 32768,
      outputTokens: null,
      source: "manual",
      contextEdited: true,
    },
  ];
  const result = await runEndpointTest({
    endpoint: draft(server.base, "llamacpp"),
    apiKey: "",
    previousModels: manual,
    probeModelId: "qwen",
  });
  assert.deepEqual(result.protocols, {
    messages: "unsupported",
    responses: "unsupported",
    chatCompletions: "ok",
  });
  assert.deepEqual(result.reasons, { messages: "notFound", responses: "notFound" });
  // Nothing accepted the unlisted model, so the 404s still mean a missing model.
  const azure = await fakeEndpoint(t, azureRoutes("az-key"));
  const missing = await runEndpointTest({
    endpoint: {
      preset: "custom",
      openaiBaseUrl: `${azure.base}/openai/v1`,
      anthropicBaseUrl: null,
      authHeader: "api-key",
    },
    apiKey: "az-key",
    previousModels: [],
    probeModelId: "other-deploy",
  });
  assert.equal(missing.protocols.responses, "failed");
  assert.equal(missing.reasons.responses, "modelNotFound");
  assert.equal(missing.reasons.chatCompletions, "modelNotFound");
});

test("a 400 for an unknown model does not prove the model exists", async (t) => {
  // OpenAI-style: one route rejects an unknown model with 400, another with 404.
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: [{ id: "real" }] } }),
    "POST /v1/chat/completions": () => ({
      status: 400,
      json: { error: { code: "model_not_found" } },
    }),
  });
  const result = await runEndpointTest({
    endpoint: { ...draft(server.base, "custom"), anthropicBaseUrl: null },
    apiKey: "",
    previousModels: [],
    probeModelId: "bogus",
  });
  assert.equal(result.protocols.responses, "failed");
  assert.equal(result.reasons.responses, "modelNotFound");
});

test("upstream error bodies containing the key are never returned", async (t) => {
  const server = await fakeEndpoint(t, {
    "GET /v1/models": () => ({ json: { data: [{ id: "m" }] } }),
    "POST /v1/chat/completions": () => ({
      status: 500,
      json: { error: "bad key secret-xyz" },
    }),
  });
  const result = await runEndpointTest({
    endpoint: { ...draft(server.base, "custom"), anthropicBaseUrl: null },
    apiKey: "secret-xyz",
    previousModels: [],
  });
  assert.equal(JSON.stringify(result).includes("secret-xyz"), false);
  assert.equal(result.reasons.chatCompletions, "http");
});
