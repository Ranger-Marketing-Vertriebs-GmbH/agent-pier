import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { normalizeOpenRouter } from "../../server/features/providers/catalog-normalization.js";
test("central provider lease isolates secrets, blocks rotation while held and sees later revocation", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-models-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const c = connections.create({
    providerId: "openrouter",
    name: "Router",
    apiKey: "private-fixture-key",
  });
  const models = new AssistantModels({ connections });
  assert.equal(
    JSON.stringify(models.listCapabilities()).includes("private-fixture-key"),
    false,
  );
  const lease = models.resolve({ connectionId: c.id, modelId: "openai/gpt-4.1-mini" });
  assert.equal(lease.provider.apiKey, "private-fixture-key");
  assert.throws(() => connections.update(c.id, { apiKey: "rotated" }), { status: 409 });
  lease.release();
  connections.update(c.id, { apiKey: "rotated" });
  const rotated = models.resolve({ connectionId: c.id, modelId: "openai/gpt-4.1-mini" });
  assert.equal(rotated.provider.apiKey, "rotated");
  rotated.release();
  connections.update(c.id, { removeApiKey: true });
  assert.throws(
    () => models.resolve({ connectionId: c.id, modelId: "openai/gpt-4.1-mini" }),
    { status: 400 },
  );
  assert.throws(() => models.resolve({ connectionId: "missing", modelId: "model" }));
});
test("native account selection uses the account adapter and never fabricates a provider key", async () => {
  const seen = [];
  const models = new AssistantModels({
    connections: { list: () => [] },
    accounts: {
      capabilities: () => [{ id: "openclaw:test", name: "ChatGPT", available: true }],
      resolve: async (id, model) => {
        seen.push([id, model]);
        return { modelRef: "openai/gpt-6-astra@selected", release() {} };
      },
    },
  });
  assert.equal(models.listCapabilities()[0].id, "openclaw:test");
  const lease = await models.resolve({
    connectionId: "openclaw:test",
    modelId: "gpt-6-astra",
  });
  assert.equal(lease.modelRef, "openai/gpt-6-astra@selected");
  assert.equal(lease.provider, undefined);
  assert.deepEqual(seen, [["openclaw:test", "gpt-6-astra"]]);
});

test("transport identities stay stable within a process without exposing reproducible credential hashes", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-identity-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const connection = connections.create({
    providerId: "openrouter",
    name: "Router",
    apiKey: "synthetic-low-entropy-key",
  });
  const input = { connectionId: connection.id, modelId: "fixture-model" };
  const firstProcess = new AssistantModels({ connections });
  const first = firstProcess.resolve(input);
  first.release();
  const repeated = firstProcess.resolve(input);
  repeated.release();
  assert.equal(repeated.providerId, first.providerId);
  const secondProcess = new AssistantModels({ connections });
  const independent = secondProcess.resolve(input);
  independent.release();
  assert.notEqual(
    independent.providerId,
    first.providerId,
    "public transport identity must not be a reproducible function of credentials",
  );
  connections.update(connection.id, { apiKey: "rotated-synthetic-key" });
  const rotated = firstProcess.resolve(input);
  rotated.release();
  assert.notEqual(rotated.providerId, first.providerId);
  assert.equal(rotated.provider.apiKey, "rotated-synthetic-key");
});

test("OpenRouter models the catalog lists with image input get it in their transport", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-images-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const c = connections.create({ providerId: "openrouter", name: "Router", apiKey: "k" });
  const catalog = normalizeOpenRouter({
    data: [
      ["google/gemini-3.8-flash", ["text", "image", "file"]],
      ["z-ai/glm-5.3", ["text"]],
    ].map(([id, input]) => ({
      id,
      name: id,
      architecture: { input_modalities: input, output_modalities: ["text"] },
      supported_parameters: ["tools"],
    })),
  });
  assert.deepEqual(
    catalog.map((m) => [m.modelId, m.capabilities.imageInput]),
    [
      ["google/gemini-3.8-flash", true],
      ["z-ai/glm-5.3", false],
    ],
  );
  const models = new AssistantModels({
    connections,
    catalog: {
      get: (providerId, modelId) => {
        const found = catalog.find((m) => m.modelId === modelId);
        if (providerId !== "openrouter" || !found) throw Error("not in catalog");
        return found;
      },
    },
  });
  const lease = (modelId) => {
    const resolved = models.resolve({ connectionId: c.id, modelId });
    resolved.release();
    return resolved.provider.models[0];
  };
  assert.deepEqual(lease("google/gemini-3.8-flash").input, ["text", "image"]);
  assert.equal(lease("z-ai/glm-5.3").input, undefined);
  assert.equal(lease("custom/unknown").input, undefined);
  const imageInput = (modelId) => models.imageInput({ connectionId: c.id, modelId });
  assert.equal(imageInput("google/gemini-3.8-flash"), true);
  assert.equal(imageInput("z-ai/glm-5.3"), false);
  assert.equal(imageInput("custom/unknown"), false);
  assert.equal(models.imageInput({ connectionId: "openclaw:a", modelId: "gpt" }), true);
  assert.equal(models.imageInput({ connectionId: "missing", modelId: "x" }), null);
});

test("an endpoint connection's capability carries its preset, never its address or key", () => {
  const connection = {
    id: "azure",
    name: "azure test",
    providerId: "endpoint",
    hasSecret: true,
    endpoint: {
      preset: "azure",
      openaiBaseUrl: "https://example.openai.azure.com/openai/v1",
      authHeader: "api-key",
      protocols: { chatCompletions: true },
      models: [{ modelId: "deploy", label: "deploy", contextTokens: 128000 }],
    },
  };
  const models = new AssistantModels({ connections: { list: () => [connection] } });
  const [capability] = models.listCapabilities();
  assert.deepEqual(capability.endpoint, { preset: "azure" });
  // Only the preset is passed on: no address, header or key field.
  const fields = (value) =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, item]) => [key, ...fields(item)])
      : [];
  for (const field of ["openaiBaseUrl", "authHeader", "apiKey", "hasSecret"])
    assert.equal(fields(capability).includes(field), false, field);
});

test("an OpenRouter model's catalog price is compiled into its transport", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-cost-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const c = connections.create({ providerId: "openrouter", name: "Router", apiKey: "k" });
  const row = (id, pricing) => ({
    id,
    name: id,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools"],
    pricing,
  });
  const rows = normalizeOpenRouter({
    data: [
      row("vendor/cached", {
        prompt: "0.000003",
        completion: "0.000015",
        input_cache_read: "0.0000003",
        input_cache_write: "0.00000375",
      }),
      row("vendor/plain", { prompt: "0.000002", completion: "0.000008" }),
      row("vendor/free", { prompt: "0", completion: "0" }),
      // Dynamic pricing ("-1"): no price to estimate from.
      row("vendor/dynamic", { prompt: "-1", completion: "-1" }),
      row("vendor/half", { prompt: "0.000002" }),
    ],
  });
  const models = new AssistantModels({
    connections,
    catalog: {
      get(providerId, modelId) {
        const found = rows.find((m) => m.modelId === modelId);
        if (providerId !== "openrouter" || !found) throw Error("not in catalog");
        return found;
      },
    },
  });
  const costOf = (modelId) => {
    const lease = models.resolve({ connectionId: c.id, modelId });
    lease.release();
    return lease.provider.models[0].cost;
  };
  // USD per 1M tokens, as OpenClaw's model entry takes it.
  assert.deepEqual(costOf("vendor/cached"), {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  // Without a cache price of its own, cached input costs what input costs.
  assert.deepEqual(costOf("vendor/plain"), {
    input: 2,
    output: 8,
    cacheRead: 2,
    cacheWrite: 2,
  });
  // A free model is priced at nothing, which OpenClaw reports as a cost of 0.
  assert.deepEqual(costOf("vendor/free"), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // No invented price: the entry carries none, and OpenClaw counts the call as
  // unpriced unless OpenRouter's answer names what it billed.
  for (const modelId of ["vendor/dynamic", "vendor/half", "vendor/unlisted"])
    assert.equal(costOf(modelId), undefined, modelId);
  assert.equal(
    new AssistantModels({ connections }).resolve({
      connectionId: c.id,
      modelId: "vendor/plain",
    }).provider.models[0].cost,
    undefined,
  );
});

test("an endpoint model's transport carries no price: AgentPier knows none", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-cost-endpoint-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const c = connections.create({
    providerId: "endpoint",
    name: "Local",
    endpoint: {
      preset: "custom",
      openaiBaseUrl: "http://127.0.0.1:9/v1",
      authHeader: null,
      protocols: { messages: false, responses: false, chatCompletions: true },
      models: [
        { modelId: "local", source: "manual", contextTokens: 32768, outputTokens: 4096 },
      ],
    },
  });
  const lease = new AssistantModels({ connections }).resolve({
    connectionId: c.id,
    modelId: "local",
  });
  lease.release();
  assert.equal("cost" in lease.provider.models[0], false);
});
