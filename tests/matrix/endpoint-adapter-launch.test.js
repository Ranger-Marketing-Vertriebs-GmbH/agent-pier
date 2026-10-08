import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";
import { ADAPTER_URL_PLACEHOLDER } from "../../server/features/providers/adapter-launch.js";

const KEY = "upstream-secret-key";
// `via(tool, source)` enables exactly that source and routes the tool to it explicitly.
const via = (tool, source, extra = {}) =>
  endpoint({ [source]: true }, { routing: { [tool]: `adapter:${source}` }, ...extra });
const endpoint = (protocols, extra = {}) =>
  validateEndpoint({
    preset: "custom",
    openaiBaseUrl: "https://llm.example/v1",
    anthropicBaseUrl: "https://llm.example",
    protocols: {
      messages: false,
      responses: false,
      chatCompletions: false,
      ...protocols,
    },
    authHeader: null,
    models: [
      {
        modelId: "qwen3",
        label: "Qwen",
        contextTokens: 65536,
        outputTokens: 8192,
        source: "manual",
        contextEdited: true,
        images: true,
      },
    ],
    lastTest: null,
    ...extra,
  });

const tempRoot = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-adapter-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

/** Parses Codex `-c name=<toml value>` arguments the way Codex does (tomlValue quotes keys). */
const overrides = (args) =>
  Object.fromEntries(
    args.flatMap((arg, index) => {
      if (args[index - 1] !== "-c") return [];
      const split = arg.indexOf("=");
      return [[arg.slice(0, split), parseToml(`v = ${arg.slice(split + 1)}`).v]];
    }),
  );

function launch(
  t,
  tool,
  block,
  root = tempRoot(t),
  inherited = { NO_PROXY: "corp.example" },
) {
  const result = prepareProviderLaunch(
    { kind: "managed", tool, provider: { id: "endpoint", modelId: "qwen3" } },
    { apiKey: KEY },
    {
      command: `/opt/${tool}`,
      args: [],
      env: {
        PATH: "/bin",
        HOME: root,
        HTTPS_PROXY: "http://proxy:3128",
        ...inherited,
      },
    },
    {
      root,
      catalog: new ProviderCatalog(),
      cliVersion: "2.1.291",
      endpoint: block,
      connectionName: "GPU",
    },
  );
  const files = [];
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .forEach((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : files.push([
              path.join(dir, e.name),
              fs.readFileSync(path.join(dir, e.name), "utf8"),
            ]),
      );
  walk(root);
  return { result, files, root };
}

function assertNoLeak(result, files) {
  const token = result.adapter.token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(result.env).includes(KEY), false, "key in env");
  assert.equal(JSON.stringify(result.args).includes(KEY), false, "key in argv");
  for (const secret of [KEY, token])
    assert.equal(
      JSON.stringify(result.provider).includes(secret),
      false,
      "secret in provider metadata",
    );
  for (const [file, text] of files) {
    for (const forbidden of [KEY, token, ADAPTER_URL_PLACEHOLDER, "127.0.0.1"])
      assert.equal(text.includes(forbidden), false, `${forbidden} in ${file}`);
  }
  assert.equal(result.env.NO_PROXY, "corp.example,127.0.0.1,localhost");
  assert.equal(result.env.no_proxy, "corp.example,127.0.0.1,localhost");
  assert.equal(result.adapter.upstream.apiKey, KEY);
}

for (const source of ["responses", "chatCompletions"])
  test(`Claude Code via adapter from ${source}`, (t) => {
    const { result, files } = launch(t, "claude", via("claude", source));
    assertNoLeak(result, files);
    assert.equal(result.env.ANTHROPIC_BASE_URL, ADAPTER_URL_PLACEHOLDER);
    assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, result.adapter.token);
    assert.equal(result.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(result.env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");
    assert.equal(result.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192");
    assert.deepEqual(result.provider.route, { mode: "adapter", source });
    assert.equal(result.adapter.clientProtocol, "messages");
    assert.equal(
      result.adapter.upstreamProtocol,
      source === "chatCompletions" ? "chat" : "responses",
    );
    assert.equal(result.adapter.upstream.baseUrl, "https://llm.example/v1");
  });

for (const source of ["messages", "chatCompletions"])
  test(`Codex via adapter from ${source}`, (t) => {
    const { result, files } = launch(t, "codex", via("codex", source));
    assertNoLeak(result, files);
    assert.equal(result.env.AGENTPIER_ENDPOINT_API_KEY, result.adapter.token);
    const argv = overrides(result.args);
    assert.equal(
      argv.model_providers["agentpier-endpoint"].base_url,
      "__AGENTPIER_ADAPTER_URL__/v1",
    );
    assert.equal(
      argv.model_providers["agentpier-endpoint"].env_key,
      "AGENTPIER_ENDPOINT_API_KEY",
    );
    assert.equal(argv.web_search, "disabled");
    const toml = parseToml(files.find(([f]) => f.endsWith("config.toml"))[1]);
    assert.equal(toml.web_search, "disabled");
    assert.equal(toml.model_providers["agentpier-endpoint"].base_url, undefined);
    assert.equal(toml.model_providers["agentpier-endpoint"].env_http_headers, undefined);
    const catalog = JSON.parse(files.find(([f]) => f.endsWith("models.json"))[1])
      .models[0];
    assert.equal(catalog.apply_patch_tool_type, "freeform");
    assert.deepEqual(catalog.input_modalities, ["text", "image"]);
    assert.equal(catalog.supports_reasoning_summaries, source === "messages");
    assert.equal(
      result.adapter.upstream.baseUrl,
      source === "messages" ? "https://llm.example" : "https://llm.example/v1",
    );
  });

test("custom auth header stays on the adapter hop", (t) => {
  const { result, files } = launch(
    t,
    "claude",
    via("claude", "chatCompletions", { authHeader: "api-key" }),
  );
  assertNoLeak(result, files);
  assert.equal(result.adapter.upstream.authHeader, "api-key");
  assert.equal(result.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
});

test("a native route after an adapter route removes the adapter from config.toml and env", (t) => {
  const root = tempRoot(t);
  const first = launch(t, "codex", via("codex", "chatCompletions"), root);
  assert.ok(first.result.adapter);
  const { result, files } = launch(t, "codex", endpoint({ responses: true }), root);
  assert.equal(result.adapter, undefined);
  assert.deepEqual(result.provider.route, { mode: "native", source: "responses" });
  const toml = parseToml(files.find(([f]) => f.endsWith("config.toml"))[1]);
  assert.equal(
    toml.model_providers["agentpier-endpoint"].base_url,
    "https://llm.example/v1",
  );
  assert.equal(
    toml.web_search,
    undefined,
    "the adapter-only web_search override is removed",
  );
  assert.equal(
    overrides(result.args).model_providers["agentpier-endpoint"].base_url,
    "https://llm.example/v1",
  );
  assert.equal(result.env.AGENTPIER_ENDPOINT_API_KEY, KEY, "native routes keep the key");
  assert.equal(result.env.NO_PROXY, "corp.example");
  assert.equal(result.env.no_proxy, undefined);
});

test("each launch gets a fresh token", (t) => {
  const a = launch(t, "claude", via("claude", "chatCompletions")).result.adapter.token;
  const b = launch(t, "claude", via("claude", "chatCompletions")).result.adapter.token;
  assert.notEqual(a, b);
});

test("auto on a Chat-only endpoint launches Claude Code and Codex through the adapter", (t) => {
  const claude = launch(t, "claude", endpoint({ chatCompletions: true })).result;
  assert.equal(claude.adapter.clientProtocol, "messages");
  assert.equal(claude.adapter.upstreamProtocol, "chat");
  const codex = launch(t, "codex", endpoint({ chatCompletions: true })).result;
  assert.equal(codex.adapter.clientProtocol, "responses");
  assert.equal(codex.adapter.upstreamProtocol, "chat");
});

test("loopback bypass merges both inherited lists into one", (t) => {
  const { result } = launch(t, "claude", via("claude", "chatCompletions"), undefined, {
    NO_PROXY: "a.example,127.0.0.1",
    no_proxy: "b.example,a.example",
  });
  const expected = "a.example,127.0.0.1,b.example,localhost";
  assert.equal(result.env.NO_PROXY, expected);
  assert.equal(result.env.no_proxy, expected);
  const lower = launch(t, "codex", via("codex", "messages"), undefined, {
    no_proxy: "corp.example",
  }).result;
  assert.equal(lower.env.NO_PROXY, "corp.example,127.0.0.1,localhost");
  assert.equal(lower.env.no_proxy, "corp.example,127.0.0.1,localhost");
});

test("Codex custom auth header stays on the adapter hop", (t) => {
  const { result, files } = launch(
    t,
    "codex",
    via("codex", "chatCompletions", { authHeader: "api-key" }),
  );
  assertNoLeak(result, files);
  assert.equal(result.adapter.upstream.authHeader, "api-key");
  const toml = parseToml(files.find(([f]) => f.endsWith("config.toml"))[1]);
  for (const provider of [
    toml.model_providers["agentpier-endpoint"],
    overrides(result.args).model_providers["agentpier-endpoint"],
  ]) {
    assert.equal(provider.env_key, "AGENTPIER_ENDPOINT_API_KEY");
    assert.equal(provider.env_http_headers, undefined);
  }
});

test("a native route with a custom header before an adapter route leaves no stale config", (t) => {
  const root = tempRoot(t);
  launch(t, "codex", endpoint({ responses: true }, { authHeader: "api-key" }), root);
  const { result, files } = launch(t, "codex", via("codex", "chatCompletions"), root);
  assertNoLeak(result, files);
  const toml = parseToml(files.find(([f]) => f.endsWith("config.toml"))[1]);
  const provider = toml.model_providers["agentpier-endpoint"];
  assert.equal(provider.base_url, undefined);
  assert.equal(provider.env_http_headers, undefined);
  assert.equal(provider.env_key, "AGENTPIER_ENDPOINT_API_KEY");
  assert.equal(toml.web_search, "disabled");
});
