import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { normalizeOpenRouter } from "../../server/features/providers/catalog-normalization.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { publicProviderConfiguration } from "../../server/features/sessions/provider-configuration.js";
import { ModelController } from "../../server/features/models/model-controller.js";

const cases = [
  ["routing smaller", 1310720, 1048576, 1048576],
  ["model smaller", 128000, 200000, 128000],
  ["equal limits", 200000, 200000, 200000],
  ["model only", 128000, undefined, 128000],
  ["routing only", undefined, 200000, 200000],
  ["both missing", undefined, undefined, null],
  ["invalid limits remain unknown", -1, "200000", null],
];

for (const [name, headline, routing, expected] of cases) {
  test(`Codex OpenRouter context: ${name}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-codex-context-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalog = new ProviderCatalog();
    catalog.models.openrouter = normalizeOpenRouter({
      data: [
        {
          id: "fixture/model",
          context_length: headline,
          top_provider: { context_length: routing },
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
        },
      ],
    });
    const result = prepareProviderLaunch(
      {
        kind: "managed",
        tool: "codex",
        provider: { id: "openrouter", modelId: "fixture/model" },
      },
      { apiKey: "fixture-only-key" },
      { command: "/fixture/codex", args: [], env: { HOME: root, PATH: "/bin" } },
      { root, catalog },
    );
    const config = parseToml(
      fs.readFileSync(path.join(result.env.CODEX_HOME, "config.toml"), "utf8"),
    );
    const overrides = Object.fromEntries(
      result.args.flatMap((arg, index) =>
        arg === "-c" ? Object.entries(parseToml(result.args[index + 1])) : [],
      ),
    );
    assert.equal(config.model_context_window ?? null, expected);
    assert.equal(overrides.model_context_window ?? null, expected);
    assert.equal(config.model_catalog_json, undefined);
    assert.equal(config.model_reasoning_effort, undefined);
    assert.equal(config.model, "fixture/model");
    assert.equal(config.model_providers.openrouter.auth.command, "sh");
    assert.equal(JSON.stringify(config).includes("fixture-only-key"), false);
    const provider = publicProviderConfiguration(result.provider);
    assert.equal(provider.assumedContextTokens, expected);
    assert.equal(provider.contextStatus, expected ? "configured" : "native-catalog");
    assert.equal(provider.modelChangeRequiresRestart, expected !== null);
    assert.equal(provider.effectiveModelId, null);
    if (expected !== null) {
      const touched = [];
      const controller = new ModelController({
        sessions: {
          control: async (_id, callback) =>
            callback({
              session: { tool: "codex", provider },
              screen: async () => {
                touched.push("screen");
                return "";
              },
              keys: async () => touched.push("keys"),
              type: async () => touched.push("type"),
            }),
        },
      });
      for (const operation of ["open", "select", "search"])
        await assert.rejects(
          controller[operation]("owned-fixture", {}),
          (error) => error.status === 409,
        );
      assert.deepEqual(touched, []);
    }
  });
}
