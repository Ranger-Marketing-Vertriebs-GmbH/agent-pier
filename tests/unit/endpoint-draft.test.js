import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  originsChanged,
  suggestAnthropicUrl,
  endpointPayload,
  initialEndpoint,
  keyReentryRequired,
  withoutTest,
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

test("applyProposal keeps unsaved draft models", () => {
  const draft = {
    ...initialEndpoint(null, "ollama"),
    models: [
      {
        modelId: "d",
        label: "My D",
        contextTokens: 8192,
        outputTokens: 2048,
        source: "detected",
        contextEdited: true,
      },
      {
        modelId: "m",
        label: "m",
        contextTokens: 4096,
        outputTokens: null,
        source: "manual",
        contextEdited: true,
      },
    ],
  };
  const proposal = {
    listed: true,
    protocols: { messages: "ok", responses: "ok", chatCompletions: "ok" },
    reasons: {},
    models: [
      {
        modelId: "d",
        label: "d",
        contextTokens: 131072,
        outputTokens: null,
        source: "detected",
        contextEdited: false,
        contextHint: 131072,
      },
    ],
  };
  const next = applyProposal(draft, proposal);
  assert.deepEqual(
    next.models.map((model) => [model.modelId, model.source, model.contextTokens]),
    [
      ["d", "detected", 8192],
      ["m", "manual", 4096],
    ],
  );
  assert.equal(next.models[0].label, "My D");
  assert.equal(next.models[0].outputTokens, 2048);
  assert.equal(next.models[0].contextHint, 131072);
  const same = applyProposal(draft, { ...proposal, listed: false, models: [] });
  assert.deepEqual(same.models, draft.models);
});

test("applyProposal keeps manual models and caps the merged list at 200", () => {
  const manual = (modelId) => ({
    modelId,
    label: modelId,
    contextTokens: 128000,
    outputTokens: null,
    source: "manual",
    contextEdited: true,
  });
  const draft = {
    ...initialEndpoint(null, "custom"),
    models: [manual("deploy-a"), manual("deploy-b")],
  };
  const proposal = {
    listed: true,
    protocols: { messages: "skipped", responses: "ok", chatCompletions: "ok" },
    reasons: {},
    models: Array.from({ length: 200 }, (_, index) => ({
      modelId: `m-${index}`,
      label: `m-${index}`,
      contextTokens: null,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    })),
  };
  const next = applyProposal(draft, proposal);
  assert.equal(next.models.length, 200);
  const ids = next.models.map((model) => model.modelId);
  assert.ok(ids.includes("deploy-a") && ids.includes("deploy-b"));
  assert.ok(!ids.includes("m-199"));
  assert.equal(next.modelsTruncated, true);
  assert.equal(endpointPayload(next).models.length, 200);
  const small = applyProposal(draft, {
    ...proposal,
    models: proposal.models.slice(0, 3),
  });
  assert.equal(small.modelsTruncated, false);
});

test("origins compare like the server: deduplicated non-empty origins", () => {
  const keyed = { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "http://a:1" };
  // Clearing a same-host Anthropic URL keeps the origin set {http://a:1}.
  assert.equal(
    originsChanged(keyed, { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "" }),
    false,
  );
  // Adding a same-host Anthropic URL keeps the origin set as well.
  assert.equal(
    originsChanged(
      { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: null },
      { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "http://a:1" },
    ),
    false,
  );
  assert.equal(
    originsChanged(keyed, {
      openaiBaseUrl: "http://a:1/v1",
      anthropicBaseUrl: "http://b:1",
    }),
    true,
  );
  assert.equal(
    originsChanged(
      { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "http://b:1" },
      { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: "" },
    ),
    true,
  );
});

test("key re-entry ignores a whitespace-only key", () => {
  const connection = {
    hasSecret: true,
    endpoint: { openaiBaseUrl: "http://a:1/v1", anthropicBaseUrl: null },
  };
  const draft = { openaiBaseUrl: "http://b:1/v1", anthropicBaseUrl: "" };
  const required = (apiKey, removeApiKey = false) =>
    keyReentryRequired({ connection, draft, apiKey, removeApiKey });
  assert.equal(required(""), true);
  assert.equal(required("   "), true);
  assert.equal(required("new-key"), false);
  assert.equal(required("", true), false);
  assert.equal(
    keyReentryRequired({
      connection: { ...connection, hasSecret: false },
      draft,
      apiKey: "",
      removeApiKey: false,
    }),
    false,
  );
});

test("an existing connection never auto-fills its Anthropic URL", () => {
  const saved = {
    preset: "custom",
    openaiBaseUrl: "https://gw.example/v1",
    anthropicBaseUrl: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
    authHeader: null,
    models: [],
    lastTest: null,
  };
  assert.equal(initialEndpoint({ endpoint: saved }).anthropicAuto, false);
  assert.equal(initialEndpoint(null, "custom").anthropicAuto, undefined);
});

test("withoutTest drops the stored test result but keeps protocol choices", () => {
  const draft = {
    ...initialEndpoint(null, "ollama"),
    protocols: { messages: true, responses: false, chatCompletions: true },
    lastTest: { at: "2026-10-06T00:00:00.000Z", protocols: {}, reasons: {} },
    modelsTruncated: true,
  };
  const next = withoutTest(draft);
  assert.equal(next.lastTest, null);
  assert.equal(next.modelsTruncated, false);
  assert.deepEqual(next.protocols, draft.protocols);
  assert.equal(endpointPayload(next).lastTest, null);
});
