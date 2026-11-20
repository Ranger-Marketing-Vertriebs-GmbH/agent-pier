import test from "node:test";
import assert from "node:assert/strict";
import {
  initialEndpoint,
  withOpenaiUrl,
} from "../../web/features/provider-connections/endpoint-draft.js";

// A saved endpoint whose base URL changes (AGENTPIER-398): the derived Anthropic URL
// follows, and models detected on the old server do not stay on the new one.
const saved = (endpoint) =>
  initialEndpoint({
    endpoint: {
      preset: "custom",
      openaiBaseUrl: "http://old.example:8080/v1",
      anthropicBaseUrl: "http://old.example:8080",
      protocols: { messages: true, responses: false, chatCompletions: true },
      authHeader: null,
      models: [
        { modelId: "old-model", label: "old-model", source: "detected" },
        { modelId: "mine", label: "mine", source: "manual" },
      ],
      lastTest: null,
      ...endpoint,
    },
  });

test("a derived Anthropic URL follows a changed base URL; a custom one stays", () => {
  const moved = withOpenaiUrl(saved(), "http://new.example:9090/v1");
  assert.equal(moved.anthropicBaseUrl, "http://new.example:9090");
  const custom = saved({ anthropicBaseUrl: "https://claude.example/anthropic" });
  assert.equal(
    withOpenaiUrl(custom, "http://new.example:9090/v1").anthropicBaseUrl,
    "https://claude.example/anthropic",
  );
  const cleared = saved({ anthropicBaseUrl: null });
  assert.equal(withOpenaiUrl(cleared, "http://new.example:9090/v1").anthropicBaseUrl, "");
});

test("models detected on another server leave with its address and come back with it", () => {
  const draft = saved();
  const moved = withOpenaiUrl(draft, "http://new.example:9090/v1");
  assert.deepEqual(
    moved.models.map((model) => model.modelId),
    ["mine"],
  );
  // A path on the same server keeps them.
  assert.deepEqual(
    withOpenaiUrl(draft, "http://old.example:8080/v2").models.map((m) => m.modelId),
    ["old-model", "mine"],
  );
  // Typing the old address again brings them back.
  const back = withOpenaiUrl(
    withOpenaiUrl(moved, "http://new.example:9090/v"),
    "http://old.example:8080/v1",
  );
  assert.deepEqual(
    back.models.map((model) => model.modelId),
    ["old-model", "mine"],
  );
});
