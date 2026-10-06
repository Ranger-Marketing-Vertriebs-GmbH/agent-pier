import test from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  CATALOG_PROVIDERS,
  TOOL_PROTOCOL,
  catalogProviderDefinition,
} from "../../server/features/providers/provider-definitions.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";

test("registry separates catalog providers from the endpoint provider", () => {
  assert.equal(PROVIDERS.endpoint.kind, "endpoint");
  assert.equal(PROVIDERS.endpoint.keyRequired, false);
  assert.deepEqual(Object.keys(CATALOG_PROVIDERS), [
    "openrouter",
    "zai",
    "zai-coding-plan",
  ]);
  assert.equal(PROVIDERS.zai.responsesGate, true);
  assert.equal(PROVIDERS.openrouter.responsesGate, false);
  assert.deepEqual(TOOL_PROTOCOL, {
    claude: "messages",
    codex: "responses",
    opencode: "chatCompletions",
  });
  assert.throws(() => catalogProviderDefinition("endpoint"));
});

test("catalog starts with the endpoint provider registered and never lists it", () => {
  const catalog = new ProviderCatalog();
  assert.equal(Object.hasOwn(catalog.status(), "endpoint"), false);
  assert.ok(catalog.list().every((model) => model.providerId !== "endpoint"));
  assert.deepEqual(
    catalog.providers().find((provider) => provider.id === "endpoint"),
    {
      id: "endpoint",
      name: "Custom endpoint",
      kind: "endpoint",
      tools: ["codex", "claude", "opencode"],
    },
  );
  assert.throws(() => catalog.list({ providerId: "endpoint" }), { status: 400 });
  assert.throws(() => catalog.refresh("endpoint"), { status: 400 });
});
