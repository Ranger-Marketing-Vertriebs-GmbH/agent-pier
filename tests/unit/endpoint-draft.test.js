import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  originsChanged,
  suggestAnthropicUrl,
  endpointPayload,
  initialEndpoint,
} from "../../web/features/provider-connections/endpoint-draft.js";

test("draft helpers", () => {
  assert.equal(suggestAnthropicUrl("https://x.example/v1/"), "https://x.example");
  const saved = { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: null };
  assert.equal(
    originsChanged(saved, { openaiBaseUrl: "http://a:1/other", anthropicBaseUrl: "" }),
    false,
  );
  assert.equal(
    originsChanged(saved, { openaiBaseUrl: "http://b:1/v1", anthropicBaseUrl: "" }),
    true,
  );
  const draft = initialEndpoint(null, "ollama");
  const next = applyProposal(
    draft,
    {
      protocols: { messages: "failed", responses: "ok", chatCompletions: "skipped" },
      reasons: { messages: "auth" },
      models: [],
    },
    "2026-10-06T00:00:00.000Z",
  );
  assert.deepEqual(next.protocols, {
    messages: false,
    responses: true,
    chatCompletions: true,
  });
  assert.equal(
    endpointPayload({ ...next, anthropicBaseUrl: " ", authHeader: "" }).anthropicBaseUrl,
    null,
  );
});

test("payload carries only server-known fields", () => {
  const draft = {
    ...initialEndpoint(null, "custom"),
    anthropicAuto: false,
    models: [
      {
        modelId: "m",
        label: "m",
        contextTokens: 4096,
        outputTokens: null,
        source: "manual",
        contextEdited: true,
        contextHint: 8192,
        extra: "x",
      },
    ],
  };
  const payload = endpointPayload(draft);
  assert.deepEqual(Object.keys(payload).sort(), [
    "anthropicBaseUrl",
    "authHeader",
    "lastTest",
    "models",
    "openaiBaseUrl",
    "preset",
    "protocols",
  ]);
  assert.deepEqual(Object.keys(payload.models[0]).sort(), [
    "contextEdited",
    "contextHint",
    "contextTokens",
    "label",
    "modelId",
    "outputTokens",
    "source",
  ]);
});

test("clearing the Anthropic URL counts as an origin change", () => {
  const saved = { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "http://a:1" };
  assert.equal(
    originsChanged(saved, { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "" }),
    true,
  );
});
