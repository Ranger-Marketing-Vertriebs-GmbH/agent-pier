import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { normalizeOpenRouter } from "../../server/features/providers/catalog-normalization.js";

function row(overrides = {}) {
  return {
    id: "vendor/code-model",
    name: "Code model",
    context_length: 200000,
    top_provider: { context_length: 128000, max_completion_tokens: 16000 },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    supported_parameters: ["tools", "tool_choice"],
    ...overrides,
  };
}

test("catalog preserves routing limits independently of the advertised window", () => {
  const [model] = normalizeOpenRouter({ data: [row()] }, "2026-09-06T00:00:00.000Z");
  assert.equal(model.contextTokens, 200000);
  assert.equal(model.routingContextTokens, 128000);
  assert.equal(model.outputTokens, 16000);
  assert.equal(model.modelId, "vendor/code-model");
});

test("catalog normalization rejects invented limits and strips unknown fields", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.integer({ max: 0 }), fc.double({ noNaN: false }), fc.string()),
      (value) => {
        fc.pre(!Number.isSafeInteger(value) || value <= 0 || value > 10000000);
        const [model] = normalizeOpenRouter({
          data: [row({ context_length: value, apiKey: "never-public" })],
        });
        assert.equal(model.contextTokens, null);
        assert.equal(JSON.stringify(model).includes("never-public"), false);
      },
    ),
    { seed: 90306, numRuns: 100 },
  );
});

test("unsafe IDs, non-text models and models without tools cannot enter the coding catalog", () => {
  const result = normalizeOpenRouter({
    data: [
      row({ id: "../../file" }),
      row({ id: "bad\n-id" }),
      row({ id: "constructor" }),
      row({
        id: "vendor/image",
        architecture: { input_modalities: ["image"], output_modalities: ["image"] },
      }),
      row({ id: "vendor/no-tools", supported_parameters: [] }),
      row(),
      row(),
    ],
  });
  assert.deepEqual(
    result.map((model) => model.modelId),
    ["vendor/code-model"],
  );
});

test("refresh persists validated catalogs and keeps last good data after a bounded-fetch failure", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-catalog-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let fail = false;
  const catalog = new ProviderCatalog({
    dataDir,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/v1/models");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, undefined);
      if (fail) throw Error("private upstream diagnostic");
      return new Response(JSON.stringify({ data: [row()] }));
    },
  });
  await catalog.refresh("openrouter");
  assert.equal(
    catalog.get("openrouter", "vendor/code-model").routingContextTokens,
    128000,
  );
  assert.equal(
    new ProviderCatalog({ dataDir }).get("openrouter", "vendor/code-model").contextTokens,
    200000,
  );
  fail = true;
  await assert.rejects(catalog.refresh("openrouter"), { status: 502 });
  assert.equal(catalog.get("openrouter", "vendor/code-model").contextTokens, 200000);
  assert.equal(catalog.status().openrouter.stale, true);
  assert.equal(
    JSON.stringify(catalog.status()).includes("private upstream diagnostic"),
    false,
  );
});

test("Z.ai Codex exposes only verified Responses models and separate Coding Plan service", () => {
  const catalog = new ProviderCatalog();
  assert.deepEqual(
    catalog.list({ providerId: "zai", tool: "codex" }).map((model) => model.modelId),
    ["glm-5.3"],
  );
  assert.deepEqual(
    catalog
      .list({ providerId: "zai-coding-plan", tool: "codex" })
      .map((model) => model.modelId),
    ["glm-5.3"],
  );
  assert.throws(
    () => catalog.get("zai-coding-plan", "glm-5.3-flash", { tool: "codex" }),
    { status: 400 },
  );
  const model = catalog.get("openrouter", "z-ai/glm-5.3");
  model.contextTokens = 1;
  assert.equal(catalog.get("openrouter", "z-ai/glm-5.3").contextTokens, 1310720);
});
