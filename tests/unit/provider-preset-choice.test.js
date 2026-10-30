import test from "node:test";
import assert from "node:assert/strict";
import {
  LISTED_PRESETS,
  PRESETS,
  initialEndpoint,
  parseProviderChoice,
  providerChoice,
} from "../../web/features/provider-connections/endpoint-draft.js";
import { connectionProviderName } from "../../web/features/provider-connections/provider-name.js";
import { ENDPOINT_PRESETS } from "../../server/features/providers/endpoint-config.js";

test("every listed preset is a server preset with the same protocols", () => {
  for (const preset of [...LISTED_PRESETS, "custom"]) {
    assert.ok(Object.hasOwn(ENDPOINT_PRESETS, preset), preset);
    assert.deepEqual(PRESETS[preset].protocols, ENDPOINT_PRESETS[preset].protocols);
  }
});

test("the API provider choice maps listed presets to the endpoint provider", () => {
  assert.deepEqual(parseProviderChoice("endpoint:azure"), {
    providerId: "endpoint",
    preset: "azure",
  });
  assert.deepEqual(parseProviderChoice("endpoint"), {
    providerId: "endpoint",
    preset: "custom",
  });
  assert.equal(parseProviderChoice("endpoint:custom").providerId, "endpoint:custom");
  assert.equal(parseProviderChoice("openrouter").providerId, "openrouter");
  assert.equal(providerChoice("endpoint", { preset: "llamacpp" }), "endpoint:llamacpp");
  assert.equal(providerChoice("endpoint", { preset: "custom" }), "endpoint");
  assert.equal(providerChoice("zai", initialEndpoint(null)), "zai");
});

test("Azure starts empty with Responses, Chat Completions and the api-key header", () => {
  const draft = initialEndpoint(null, "azure");
  assert.equal(draft.openaiBaseUrl, "");
  assert.equal(draft.anthropicAuto, false);
  assert.equal(draft.authHeader, "api-key");
  assert.equal(initialEndpoint(null, "custom").authHeader, "");
  assert.deepEqual(draft.protocols, {
    messages: false,
    responses: true,
    chatCompletions: true,
  });
});

test("a stored endpoint shows its recorded preset, otherwise Custom endpoint", () => {
  const endpoint = (preset) => ({ providerId: "endpoint", endpoint: { preset } });
  assert.equal(connectionProviderName(endpoint("ollama")), "Ollama");
  assert.equal(connectionProviderName(endpoint("azure")), "Azure OpenAI");
  assert.equal(connectionProviderName(endpoint("custom")), "Eigener Endpunkt");
  assert.equal(connectionProviderName({ providerId: "endpoint" }), "Eigener Endpunkt");
  assert.equal(connectionProviderName({ providerId: "openrouter" }), "OpenRouter");
});
