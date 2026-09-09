import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateProviderSelection } from "../../server/features/providers/provider-definitions.js";

const catalog = new ProviderCatalog();
function launch(t, tool, id, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-provider-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = {
    id,
    modelId: id === "openrouter" ? "anthropic/claude-sonnet-4.6" : "glm-5.3",
    ...(tool === "codex" && id !== "openrouter" ? { responsesAccess: true } : {}),
    ...options.selection,
  };
  return prepareProviderLaunch(
    { kind: "managed", tool, provider },
    { apiKey: "fixture-key-only" },
    {
      command: `/opt/${tool}`,
      args: options.args || [],
      env: { PATH: "/bin", HOME: root },
    },
    { root, catalog, cliVersion: options.cliVersion ?? "2.1.263" },
  );
}

for (const tool of ["codex", "claude", "opencode"]) {
  for (const id of ["openrouter", "zai", "zai-coding-plan"]) {
    test(`native ${tool} / ${id} launch selects exact endpoint and model without key arguments`, (t) => {
      const result = launch(t, tool, id, { args: ["--fixture-permission-mode"] });
      assert.equal(result.args[0], "--fixture-permission-mode");
      assert.equal(JSON.stringify(result.args).includes("fixture-key-only"), false);
      assert.equal(JSON.stringify(result.provider).includes("fixture-key-only"), false);
      assert.equal(result.env.OPENAI_API_KEY, undefined);
      if (tool === "codex") {
        const config = parseToml(
          fs.readFileSync(path.join(result.env.CODEX_HOME, "config.toml"), "utf8"),
        );
        const definition = config.model_providers[config.model_provider];
        assert.equal(definition.wire_api, "responses");
        assert.equal(
          definition.base_url,
          id === "openrouter"
            ? "https://openrouter.ai/api/v1"
            : "https://api.z.ai/api/v1",
        );
        assert.equal(
          config.model,
          id === "openrouter" ? "anthropic/claude-sonnet-4.6" : "glm-5.3",
        );
        assert.equal(JSON.stringify(config).includes("fixture-key-only"), false);
        if (id !== "openrouter") {
          const metadata = JSON.parse(fs.readFileSync(config.model_catalog_json, "utf8"));
          assert.equal(metadata.models[0].context_window, 1048576);
        } else assert.equal(definition.auth.command, "sh");
      } else if (tool === "claude") {
        assert.equal(
          result.env.ANTHROPIC_BASE_URL,
          id === "openrouter"
            ? "https://openrouter.ai/api"
            : "https://api.z.ai/api/anthropic",
        );
        assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "fixture-key-only");
        assert.equal(result.env.ANTHROPIC_API_KEY, "");
        assert.equal(result.env.DISABLE_COMPACT, undefined);
        assert.equal(
          result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
          id === "openrouter" ? undefined : "1000000",
        );
        assert.equal(
          result.provider.cliModelId,
          id === "openrouter" ? "anthropic/claude-sonnet-4.6[1m]" : "glm-5.3",
        );
      } else {
        const config = JSON.parse(
          fs.readFileSync(
            path.join(result.env.XDG_CONFIG_HOME, "opencode/opencode.json"),
            "utf8",
          ),
        );
        assert.equal(
          config.model,
          id === "openrouter"
            ? "openrouter/anthropic/claude-sonnet-4.6"
            : `${id}/glm-5.3`,
        );
        assert.equal(config.provider[id].npm, undefined);
        assert.equal(config.provider[id].options.baseURL, undefined);
        assert.equal(
          config.provider[id].options.apiKey,
          id === "openrouter" ? "{env:OPENROUTER_API_KEY}" : "{env:ZHIPU_API_KEY}",
        );
        assert.equal(JSON.stringify(config).includes("fixture-key-only"), false);
      }
    });
  }
}

test("Codex refuses Z.ai profiles without explicit Responses entitlement", () => {
  for (const id of ["zai", "zai-coding-plan"]) {
    assert.throws(
      () => validateProviderSelection({ id, modelId: "glm-5.3" }, "codex", catalog),
      /Responses/,
    );
    assert.throws(
      () =>
        validateProviderSelection(
          { id, modelId: "glm-5.3-flash", responsesAccess: true },
          "codex",
          catalog,
        ),
      /catalog/,
    );
  }
});

test("custom Claude model window corrections require a supported CLI version", (t) => {
  assert.throws(() => launch(t, "claude", "zai", { cliVersion: "2.1.192" }), /2\.1\.193/);
});

test("OpenRouter GLM uses the smaller routing window without disabling Claude compaction", (t) => {
  const result = launch(t, "claude", "openrouter", {
    selection: { modelId: "z-ai/glm-5.3" },
  });
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  assert.equal(result.provider.contextTokens, 1310720);
  assert.equal(result.provider.assumedContextTokens, 1048576);
  assert.equal(result.env.DISABLE_COMPACT, undefined);
});

test("OpenCode relaunch preserves extensions while pinning provider settings above project config", (t) => {
  const first = launch(t, "opencode", "openrouter");
  const file = path.join(first.env.XDG_CONFIG_HOME, "opencode/opencode.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.mcp = { memory: { type: "remote", url: "http://127.0.0.1/mcp" } };
  fs.writeFileSync(file, JSON.stringify(config));
  const next = prepareProviderLaunch(
    {
      kind: "managed",
      tool: "opencode",
      provider: { id: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
    },
    { apiKey: "fixture-key-only" },
    { command: "/opt/opencode", args: [], env: { HOME: first.env.HOME } },
    { root: first.env.HOME, catalog },
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcp, config.mcp);
  assert.equal(
    JSON.parse(next.env.OPENCODE_CONFIG_CONTENT).model,
    "openrouter/anthropic/claude-sonnet-4.6",
  );
  assert.equal(
    JSON.parse(next.env.OPENCODE_CONFIG_CONTENT).provider.openrouter.options.apiKey,
    "{env:OPENROUTER_API_KEY}",
  );
});

test("Codex launch arguments pin routing even when the repository supplies provider overrides", (t) => {
  const result = launch(t, "codex", "openrouter");
  const overrides = {};
  for (let index = 0; index < result.args.length; index++)
    if (result.args[index] === "-c")
      Object.assign(overrides, parseToml(result.args[++index]));
  assert.equal(overrides.model_provider, "openrouter");
  assert.equal(
    overrides.model_providers.openrouter.base_url,
    "https://openrouter.ai/api/v1",
  );
});

test("unknown Claude versions request a retry instead of claiming the CLI is outdated", (t) => {
  for (const cliVersion of ["", "unknown"]) {
    assert.throws(
      () => launch(t, "claude", "zai", { cliVersion }),
      (error) =>
        error.status === 409 && /could not be verified.*Retry/.test(error.message),
    );
  }
});
