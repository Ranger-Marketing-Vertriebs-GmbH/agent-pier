import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-provider-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  return { connections, models: new AssistantModels({ connections }) };
}
function endpoint(preset = "custom", overrides = {}) {
  return {
    preset,
    openaiBaseUrl: "http://127.0.0.1:8080/v1",
    protocols: { messages: false, responses: false, chatCompletions: true },
    models: [
      {
        modelId: "local/model:latest",
        label: "Local",
        contextTokens: 32768,
        outputTokens: 4096,
        source: "manual",
      },
    ],
    ...overrides,
  };
}
function create(connections, config = endpoint(), apiKey) {
  return connections.create({
    providerId: "endpoint",
    name: "Endpoint",
    endpoint: config,
    ...(apiKey ? { apiKey } : {}),
  });
}
for (const preset of ["ollama", "llamacpp", "custom"]) {
  test(`${preset} maps a central keyless model with context and output limits`, (t) => {
    const { connections, models } = fixture(t);
    const c = create(connections, endpoint(preset));
    assert.equal(models.listCapabilities()[0].available, true);
    const lease = models.resolve({ connectionId: c.id, modelId: "local/model:latest" });
    assert.equal(lease.provider.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(lease.provider.api, "openai-completions");
    assert.equal(lease.provider.apiKey, undefined);
    assert.deepEqual(lease.provider.models, [
      { id: "local/model:latest", name: "Local", contextWindow: 32768, maxTokens: 4096 },
    ]);
    assert.equal(lease.modelRef, `${lease.providerId}/local/model:latest`);
    // Agents name the owner's connection and model label, never the opaque provider.
    assert.deepEqual(lease.display, { connection: "Endpoint", model: "Local" });
    assert.throws(() => connections.remove(c.id), { status: 409 });
    lease.release();
    lease.release();
    connections.remove(c.id);
  });
}
for (const opencode of ["off", "responses"]) {
  test(`assistant Chat Completions stays available with OpenCode routing ${opencode}`, (t) => {
    const { connections, models } = fixture(t);
    const c = create(connections, endpoint("custom", { routing: { opencode } }));
    assert.equal(c.tools.includes("opencode"), false);
    assert.deepEqual(models.listCapabilities()[0].models, [
      {
        modelId: "local/model:latest",
        label: "Local",
        contextTokens: 32768,
        outputTokens: 4096,
      },
    ]);
    const lease = models.resolve({ connectionId: c.id, modelId: "local/model:latest" });
    assert.equal(lease.provider.api, "openai-completions");
    assert.equal(lease.provider.baseUrl, "http://127.0.0.1:8080/v1");
    assert.deepEqual(lease.provider.models, [
      { id: "local/model:latest", name: "Local", contextWindow: 32768, maxTokens: 4096 },
    ]);
    lease.release();
    assert.equal(connections.get(c.id).endpoint.routing.opencode, opencode);
    assert.equal(connections.get(c.id).tools.includes("opencode"), false);
  });
}
test("Azure v1 credentials use native header controls", (t) => {
  const { connections, models } = fixture(t);
  const c = create(
    connections,
    endpoint("custom", {
      openaiBaseUrl: "https://fixture.openai.azure.com/openai/v1",
      authHeader: "api-key",
      models: [{ modelId: "my-deployment", source: "manual", contextTokens: 65536 }],
    }),
    "private-azure-fixture",
  );
  const capability = models.listCapabilities()[0];
  assert.deepEqual(capability.models, [
    {
      modelId: "my-deployment",
      label: "my-deployment",
      contextTokens: 65536,
      outputTokens: 16384,
    },
  ]);
  assert.equal(JSON.stringify(capability).includes("private-azure-fixture"), false);
  const hosts = JSON.stringify(capability).match(/https?:\/\/[^"\\/\s]+/g) ?? [];
  assert.equal(
    hosts.some((host) => new URL(host).hostname === "fixture.openai.azure.com"),
    false,
  );
  const lease = models.resolve({ connectionId: c.id, modelId: "my-deployment" });
  assert.equal(lease.provider.apiKey, "private-azure-fixture");
  assert.equal(lease.provider.authHeader, false);
  assert.deepEqual(lease.provider.headers, {
    authorization: "",
    "api-key": "private-azure-fixture",
  });
  assert.equal(lease.provider.models[0].id, "my-deployment");
  lease.release();
});
test("Bearer connections stay independent and rotations are applied after lease release", (t) => {
  const { connections, models } = fixture(t);
  const first = create(connections, endpoint(), "first-key");
  const second = create(connections, endpoint(), "second-key");
  const select = (id) =>
    models.resolve({ connectionId: id, modelId: "local/model:latest" });
  const a = select(first.id),
    b = select(second.id);
  assert.notEqual(a.providerId, b.providerId);
  assert.equal(a.provider.apiKey, "first-key");
  assert.equal(b.provider.apiKey, "second-key");
  assert.equal(a.provider.request, undefined);
  assert.throws(() => connections.update(first.id, { apiKey: "rotation" }), {
    status: 409,
  });
  a.release();
  b.release();
  connections.update(first.id, { apiKey: "rotation" });
  const rotated = select(first.id);
  assert.equal(rotated.provider.apiKey, "rotation");
  assert.notEqual(rotated.providerId, a.providerId);
  rotated.release();
  connections.update(first.id, { removeApiKey: true });
  const keyless = select(first.id);
  assert.equal(keyless.provider.apiKey, undefined);
  assert.notEqual(keyless.providerId, rotated.providerId);
  keyless.release();
});
test("disabled protocol, missing context, unknown model and remote keyless fail explicitly", (t) => {
  const { connections, models } = fixture(t);
  for (const config of [
    endpoint("custom", {
      protocols: { messages: false, responses: true, chatCompletions: false },
    }),
    endpoint("custom", { models: [{ modelId: "local/model:latest", source: "manual" }] }),
    endpoint("custom", { openaiBaseUrl: "https://models.example/v1" }),
  ]) {
    const c = create(connections, config);
    const capability = models.listCapabilities().find((item) => item.id === c.id);
    assert.equal(capability.available, false);
    assert.ok(capability.reason);
    assert.throws(() =>
      models.resolve({ connectionId: c.id, modelId: "local/model:latest" }),
    );
    connections.remove(c.id);
  }
  const c = create(connections);
  assert.throws(() => models.resolve({ connectionId: c.id, modelId: "unknown" }));
  connections.update(c.id, { name: "Still mutable" });
  assert.throws(() =>
    models.resolve({ connectionId: c.id, modelId: "x@foreign-profile" }),
  );
  connections.remove(c.id);
});
test("failed secret read releases its central connection lease", (t) => {
  const { connections, models } = fixture(t);
  const c = create(connections, endpoint(), "initial-key");
  const get = connections.get.bind(connections);
  connections.get = (id) => {
    const value = get(id);
    connections.secret = () => {
      throw Error("unreadable");
    };
    return value;
  };
  assert.throws(
    () => models.resolve({ connectionId: c.id, modelId: "local/model:latest" }),
    /unreadable/,
  );
  assert.equal(connections.launches.size, 0);
});
test("unsupported catalog providers remain unavailable with an explicit reason", (t) => {
  const { connections, models } = fixture(t);
  const c = connections.create({ providerId: "zai", name: "ZAI", apiKey: "private-zai" });
  assert.deepEqual(models.listCapabilities()[0], {
    id: c.id,
    name: "ZAI",
    providerId: "zai",
    available: false,
    reason: "unsupportedProvider",
  });
  assert.throws(() => models.resolve({ connectionId: c.id, modelId: "glm" }));
  assert.equal(connections.launches.size, 0);
});

test("arbitrary custom auth headers fail closed because the native SDK cannot omit its Bearer header", (t) => {
  const { connections, models } = fixture(t);
  const c = create(
    connections,
    endpoint("custom", { authHeader: "X-Inference-Key" }),
    "private-fixture-key",
  );
  const capability = models.listCapabilities()[0];
  assert.equal(capability.available, false);
  assert.equal(capability.reason, "unsupportedAuthentication");
  assert.throws(
    () => models.resolve({ connectionId: c.id, modelId: "local/model:latest" }),
    { status: 400 },
  );
  assert.equal(connections.launches.size, 0);
});
test("model contexts below the pinned runtime's hard minimum are unavailable", (t) => {
  const { connections, models } = fixture(t);
  const c = create(
    connections,
    endpoint("custom", {
      models: [
        { modelId: "tiny", source: "manual", contextTokens: 2048 },
        { modelId: "usable", source: "manual", contextTokens: 4096 },
      ],
    }),
  );
  assert.deepEqual(
    models.listCapabilities()[0].models.map((m) => m.modelId),
    ["usable"],
  );
  assert.throws(() => models.resolve({ connectionId: c.id, modelId: "tiny" }), {
    status: 400,
  });
  assert.equal(connections.launches.size, 0);
});
test("endpoint image support and chat adapter options map to native model fields", (t) => {
  const { connections, models } = fixture(t);
  const base = endpoint().models[0];
  const c = create(
    connections,
    endpoint("custom", {
      routing: { claude: "off", codex: "adapter:chatCompletions", opencode: "off" },
      thinkTagExtraction: true,
      adapterCapabilities: {
        chatCompletions: { maxTokensField: "max_completion_tokens", streamUsage: false },
        messages: { promptCache: false },
      },
      models: [
        { ...base, images: true },
        { ...base, modelId: "text-only", images: false },
        { ...base, modelId: "unknown-images" },
      ],
    }),
  );
  const provider = (modelId) => {
    const lease = models.resolve({ connectionId: c.id, modelId });
    lease.release();
    return lease.provider;
  };
  const compat = {
    maxTokensField: "max_completion_tokens",
    supportsUsageInStreaming: false,
  };
  assert.deepEqual(provider("local/model:latest").models, [
    {
      id: "local/model:latest",
      name: "Local",
      contextWindow: 32768,
      maxTokens: 4096,
      input: ["text", "image"],
      compat,
    },
  ]);
  for (const modelId of ["text-only", "unknown-images"])
    assert.deepEqual(provider(modelId).models, [
      { id: modelId, name: "Local", contextWindow: 32768, maxTokens: 4096, compat },
    ]);
  const serialized = JSON.stringify(provider("text-only"));
  for (const field of ["routing", "adapterCapabilities", "thinkTag", "promptCache"])
    assert.equal(serialized.includes(field), false, field);
});
