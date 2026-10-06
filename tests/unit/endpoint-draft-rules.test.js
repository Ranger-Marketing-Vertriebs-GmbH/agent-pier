import test from "node:test";
import assert from "node:assert/strict";
import {
  initialEndpoint,
  modelProblem,
  modelsInvalid,
  validModelId,
  withOpenaiUrl,
} from "../../web/features/provider-connections/endpoint-draft.js";

test("the Anthropic URL follows the OpenAI URL until it was edited", () => {
  const fresh = initialEndpoint(null, "ollama");
  assert.equal(
    withOpenaiUrl(fresh, "http://gpu-box:11434/v1").anthropicBaseUrl,
    "http://gpu-box:11434",
  );
  assert.equal(
    withOpenaiUrl(initialEndpoint(null, "llamacpp"), "http://gpu:8080/v1")
      .anthropicBaseUrl,
    "http://gpu:8080",
  );
  const saved = initialEndpoint({
    endpoint: { preset: "ollama", openaiBaseUrl: "a", anthropicBaseUrl: "b", models: [] },
  });
  assert.equal(withOpenaiUrl(saved, "http://c/v1").anthropicBaseUrl, "b");
  assert.equal(
    withOpenaiUrl({ ...fresh, anthropicAuto: false }, "http://c/v1").anthropicBaseUrl,
    fresh.anthropicBaseUrl,
  );
});

test("model rules mirror the server", () => {
  const model = (extra) => ({
    modelId: "m",
    contextTokens: null,
    outputTokens: null,
    ...extra,
  });
  const check = (m, all = [m]) => modelProblem(m, all);
  assert.equal(check(model({})), null);
  assert.equal(check(model({ contextTokens: 4096, outputTokens: 4096 })), null);
  assert.equal(check(model({ modelId: "/models/a.gguf" })), "invalidId");
  assert.equal(check(model({ modelId: "has space" })), "invalidId");
  assert.equal(validModelId("org/model:8b"), true);
  assert.equal(check(model({ contextTokens: 100 })), "contextRange");
  assert.equal(check(model({ contextTokens: 2048.5 })), "contextRange");
  assert.equal(check(model({ outputTokens: 20_000_000 })), "outputRange");
  assert.equal(
    check(model({ contextTokens: 4096, outputTokens: 8192 })),
    "outputOverContext",
  );
  assert.equal(check(model({}), [model({}), model({})]), "duplicate");
  assert.equal(
    modelsInvalid(Array.from({ length: 201 }, (_, i) => model({ modelId: `m${i}` }))),
    true,
  );
});
