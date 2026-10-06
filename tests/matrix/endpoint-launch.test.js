import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";
import { providerEnvironment } from "../../server/features/providers/provider-environment.js";
import { launchTarget } from "../../server/features/providers/launch-description.js";

const catalog = new ProviderCatalog();
const endpointBlock = (overrides = {}) =>
  validateEndpoint({
    preset: "custom",
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: "https://llm.example",
    protocols: { messages: true, responses: true, chatCompletions: true },
    authHeader: null,
    models: [
      {
        modelId: "qwen3-coder:30b",
        label: "Qwen",
        contextTokens: 65536,
        outputTokens: null,
        source: "manual",
        contextEdited: true,
      },
      {
        modelId: "claude-proxy",
        label: "Proxy",
        contextTokens: 200000,
        outputTokens: 16000,
        source: "manual",
        contextEdited: true,
      },
    ],
    lastTest: null,
    ...overrides,
  });
function launch(
  t,
  tool,
  {
    key = "endpoint-secret",
    endpoint = endpointBlock(),
    modelId = "qwen3-coder:30b",
    cliVersion = "2.1.263",
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = prepareProviderLaunch(
    { kind: "managed", tool, provider: { id: "endpoint", modelId } },
    key ? { apiKey: key } : null,
    {
      command: `/opt/${tool}`,
      args: [],
      env: {
        PATH: "/bin",
        HOME: root,
        AGENTPIER_ENDPOINT_API_KEY: "inherited",
        OPENAI_API_KEY: "x",
      },
    },
    { root, catalog, cliVersion, endpoint },
  );
  const files = [];
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .forEach((entry) =>
        entry.isDirectory()
          ? walk(path.join(dir, entry.name))
          : files.push(fs.readFileSync(path.join(dir, entry.name), "utf8")),
      );
  walk(root);
  if (key) {
    assert.equal(JSON.stringify(result.args).includes(key), false, "key in argv");
    assert.equal(
      files.some((content) => content.includes(key)),
      false,
      "key in config files",
    );
  }
  assert.equal(result.env.OPENAI_API_KEY, undefined);
  assert.equal(result.provider.modelChangeRequiresRestart, true);
  return result;
}

for (const key of ["endpoint-secret", null])
  for (const header of [null, "api-key"]) {
    const label = `${key ? "key" : "no key"} / ${header || "default header"}`;
    test(`claude endpoint launch ${label}`, (t) => {
      const result = launch(t, "claude", {
        key,
        endpoint: endpointBlock({ authHeader: header }),
      });
      assert.equal(result.env.ANTHROPIC_BASE_URL, "https://llm.example");
      assert.equal(result.env.ANTHROPIC_API_KEY, "");
      assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "65536");
      assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "16384");
      assert.equal(result.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
      assert.equal(result.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
      if (key && !header) assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, key);
      else assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, "agentpier-endpoint");
      assert.equal(
        result.env.ANTHROPIC_CUSTOM_HEADERS,
        key && header ? `api-key: ${key}` : undefined,
      );
    });
    test(`codex endpoint launch ${label}`, (t) => {
      const result = launch(t, "codex", {
        key,
        endpoint: endpointBlock({ authHeader: header }),
      });
      const config = parseToml(
        fs.readFileSync(path.join(result.env.CODEX_HOME, "config.toml"), "utf8"),
      );
      const provider = config.model_providers["agentpier-endpoint"];
      assert.equal(config.model_provider, "agentpier-endpoint");
      assert.equal(provider.base_url, "https://llm.example/v1");
      assert.equal(provider.wire_api, "responses");
      assert.equal(provider.requires_openai_auth, false);
      assert.equal(config.model_context_window, 65536);
      assert.equal(
        provider.env_key,
        key && !header ? "AGENTPIER_ENDPOINT_API_KEY" : undefined,
      );
      assert.deepEqual(
        provider.env_http_headers,
        key && header ? { "api-key": "AGENTPIER_ENDPOINT_API_KEY" } : undefined,
      );
      assert.equal(result.env.AGENTPIER_ENDPOINT_API_KEY, key || undefined);
      const catalogJson = JSON.parse(fs.readFileSync(config.model_catalog_json, "utf8"));
      assert.equal(catalogJson.models[0].context_window, 65536);
      assert.deepEqual(result.args.slice(-2), ["--model", "qwen3-coder:30b"]);
    });
    test(`opencode endpoint launch ${label}`, (t) => {
      const result = launch(t, "opencode", {
        key,
        endpoint: endpointBlock({ authHeader: header }),
      });
      const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT);
      const provider = config.provider["agentpier-endpoint"];
      assert.equal(config.model, "agentpier-endpoint/qwen3-coder:30b");
      assert.equal(provider.npm, "@ai-sdk/openai-compatible");
      assert.equal(provider.options.baseURL, "https://llm.example/v1");
      assert.equal(
        provider.options.apiKey,
        key ? "{env:AGENTPIER_ENDPOINT_API_KEY}" : undefined,
      );
      assert.deepEqual(
        provider.options.headers,
        key && header ? { "api-key": "{env:AGENTPIER_ENDPOINT_API_KEY}" } : undefined,
      );
      assert.deepEqual(provider.models["qwen3-coder:30b"].limit, {
        context: 65536,
        output: 16384,
      });
    });
  }

test("claude-named endpoint model takes the non-Claude path", (t) => {
  const result = launch(t, "claude", { modelId: "claude-proxy" });
  assert.equal(result.provider.cliModelId, "claude-proxy");
  assert.equal(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
  assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "16000");
});

test("a user-set endpoint output limit above 32000 reaches Claude Code unchanged", (t) => {
  const endpoint = endpointBlock({
    models: [
      {
        modelId: "big",
        label: "Big",
        contextTokens: 400000,
        outputTokens: 64000,
        source: "manual",
        contextEdited: true,
      },
      {
        modelId: "auto",
        label: "Auto",
        contextTokens: 400000,
        outputTokens: null,
        source: "manual",
        contextEdited: true,
      },
    ],
  });
  const big = launch(t, "claude", { endpoint, modelId: "big" });
  assert.equal(big.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
  // Without a user value the fallback formula keeps its 32000 cap.
  const auto = launch(t, "claude", { endpoint, modelId: "auto" });
  assert.equal(auto.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "32000");
});

test("custom header on old Claude Code is refused; old version without header works", (t) => {
  assert.throws(
    () =>
      launch(t, "claude", {
        endpoint: endpointBlock({ authHeader: "api-key" }),
        cliVersion: "2.1.226",
      }),
    /2\.1\.227/,
  );
  assert.equal(
    launch(t, "claude", { cliVersion: "2.1.200" }).env.ANTHROPIC_AUTH_TOKEN,
    "endpoint-secret",
  );
});

test("disabled protocol refuses the launch", (t) => {
  const endpoint = endpointBlock({
    protocols: { messages: true, responses: false, chatCompletions: true },
  });
  assert.throws(() => launch(t, "codex", { endpoint }), { status: 409 });
});

for (const header of [null, "api-key"])
  test(`claude env never carries the endpoint key without a messages URL (${header || "bearer"})`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-env-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const account = { tool: "claude", provider: { id: "endpoint" } };
    const endpoint = endpointBlock({ anthropicBaseUrl: null, authHeader: header });
    const env = providerEnvironment(
      account,
      { apiKey: "endpoint-secret" },
      { PATH: "/bin" },
      root,
      launchTarget(account, endpoint),
    );
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "agentpier-endpoint");
    assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(JSON.stringify(env).includes("endpoint-secret"), false);
  });
