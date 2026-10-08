// tests/unit/endpoint-draft-adapter.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyProposal,
  endpointPayload,
  initialEndpoint,
  resetCapabilities,
  setCapability,
  setModelImages,
  setRoute,
  withoutTest,
} from "../../web/features/provider-connections/endpoint-draft.js";

const model = (modelId, extra = {}) => ({
  modelId,
  label: modelId,
  contextTokens: 32768,
  outputTokens: null,
  source: "detected",
  contextEdited: false,
  ...extra,
});
const stored = {
  id: "c1",
  endpoint: {
    preset: "custom",
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
    authHeader: null,
    models: [model("qwen3", { images: false }), model("gemma", { images: null })],
    lastTest: null,
    routing: { claude: "adapter:chatCompletions", codex: "off", opencode: "auto" },
    adapterCapabilities: { chatCompletions: { reasoningEffort: true } },
    thinkTagExtraction: true,
  },
};

test("an untouched stored connection round-trips its adapter fields (Review Focus 5)", () => {
  const payload = endpointPayload(initialEndpoint(stored));
  assert.deepEqual(payload.routing, stored.endpoint.routing);
  assert.deepEqual(payload.adapterCapabilities, stored.endpoint.adapterCapabilities);
  assert.equal(payload.thinkTagExtraction, true);
  assert.deepEqual(
    payload.models.map((m) => m.images),
    [false, null],
  );
  assert.equal("capabilityProposal" in payload, false);
});

test("new drafts start with auto routing, no capabilities and no think extraction", () => {
  const draft = initialEndpoint(null);
  assert.deepEqual(draft.routing, { claude: "auto", codex: "auto", opencode: "auto" });
  assert.deepEqual(draft.adapterCapabilities, {});
  assert.equal(draft.thinkTagExtraction, false);
  assert.deepEqual(draft.capabilityProposal, {});
});

test("records without adapter fields load as auto with defaults", () => {
  const {
    routing: _r,
    adapterCapabilities: _a,
    thinkTagExtraction: _t,
    ...legacy
  } = stored.endpoint;
  const draft = initialEndpoint({ id: "c2", endpoint: legacy });
  assert.deepEqual(draft.routing, { claude: "auto", codex: "auto", opencode: "auto" });
  assert.deepEqual(draft.adapterCapabilities, {});
  assert.equal(draft.thinkTagExtraction, false);
});

test("a re-test keeps the image choice of detected models (Review Focus 1)", () => {
  const draft = initialEndpoint(stored);
  const next = applyProposal(draft, {
    listed: true,
    protocols: {
      messages: "unsupported",
      responses: "unsupported",
      chatCompletions: "ok",
    },
    reasons: {},
    models: [model("qwen3"), model("gemma"), model("new")],
    capabilities: {},
  });
  assert.deepEqual(
    next.models.map((m) => [m.modelId, m.images]),
    [
      ["qwen3", false],
      ["gemma", null],
      ["new", null],
    ],
  );
});

test("capability proposals are applied, marked, and cleared with the test", () => {
  const draft = initialEndpoint(stored);
  const next = applyProposal(draft, {
    listed: false,
    protocols: {
      messages: "unsupported",
      responses: "unsupported",
      chatCompletions: "ok",
    },
    reasons: {},
    models: [],
    capabilities: { chatCompletions: { reasoningEffort: false, streamUsage: true } },
  });
  assert.deepEqual(next.adapterCapabilities.chatCompletions, {
    reasoningEffort: false,
    streamUsage: true,
  });
  assert.deepEqual(next.capabilityProposal, {
    chatCompletions: { reasoningEffort: false, streamUsage: true },
  });
  const edited = setCapability(next, "chatCompletions", "reasoningEffort", true);
  assert.equal(edited.adapterCapabilities.chatCompletions.reasoningEffort, true);
  assert.deepEqual(withoutTest(edited).capabilityProposal, {});
  assert.equal(
    withoutTest(edited).adapterCapabilities.chatCompletions.reasoningEffort,
    true,
  );
  assert.equal(
    "chatCompletions" in resetCapabilities(edited, "chatCompletions").adapterCapabilities,
    false,
  );
});

test("route and image setters change only their field", () => {
  const draft = initialEndpoint(stored);
  assert.equal(setRoute(draft, "codex", "auto").routing.codex, "auto");
  assert.equal(
    setRoute(draft, "codex", "auto").routing.claude,
    "adapter:chatCompletions",
  );
  const images = setModelImages(draft, "gemma", true);
  assert.equal(images.models[1].images, true);
  assert.equal(
    images.models[1].contextEdited,
    false,
    "images do not mark the context edited",
  );
});
