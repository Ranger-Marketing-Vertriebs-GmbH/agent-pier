import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { prepareProviderLaunch } from "../../server/features/providers/provider-launch.js";
import { validateEndpoint } from "../../server/features/providers/endpoint-config.js";

// Codex defaults both credential stores to the macOS login keychain, whose entries are
// not scoped by CODEX_HOME. Managed accounts must keep both inside their own profile.
const PINS = {
  cli_auth_credentials_store: "file",
  mcp_oauth_credentials_store: "file",
};

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-codex-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = new AccountStore({ dataDir: path.join(root, "data"), home: root });
  return { root, accounts, codex: path.join(root, "fixture-bin", "codex") };
}
const configFile = (env) => path.join(env.CODEX_HOME, "config.toml");
function assertPinned(file) {
  const config = parseToml(fs.readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(PINS)) assert.equal(config[key], value, key);
  return config;
}
function assertPinnedArgs(args) {
  for (const [key, value] of Object.entries(PINS))
    assert.ok(args.includes(`${key}="${value}"`), `${key} override missing`);
}

test("a new managed Codex account seeds both file credential stores", (t) => {
  const { accounts } = fixture(t);
  const account = accounts.create({ name: "Managed", tool: "codex" });
  assertPinned(configFile(accounts.environment(account.id)));
});

for (const login of [false, true])
  test(`a managed Codex ${login ? "login" : "work"} launch repairs a missing MCP OAuth pin and keeps the rest`, (t) => {
    const { accounts, codex } = fixture(t);
    const account = accounts.create({ name: "Legacy", tool: "codex" });
    const file = configFile(accounts.environment(account.id));
    const legacy = [
      "# owner comment",
      'cli_auth_credentials_store = "file"',
      'model = "gpt-5"',
      "",
      "[mcp_servers.docs]",
      'url = "https://mcp.example/mcp"',
      "",
    ].join("\n");
    fs.writeFileSync(file, legacy, { mode: 0o600 });
    const launch = accounts.command(account.id, { codex }, login);
    assert.equal(launch.env.CODEX_HOME, path.dirname(file));
    const repaired = fs.readFileSync(file, "utf8");
    const config = assertPinned(file);
    assert.equal(config.model, "gpt-5");
    assert.equal(config.mcp_servers.docs.url, "https://mcp.example/mcp");
    assert.match(repaired, /# owner comment/);
    assert.equal(repaired.replace('mcp_oauth_credentials_store = "file"\n', ""), legacy);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const unchanged = fs.statSync(file).mtimeMs;
    accounts.command(account.id, { codex }, login);
    assert.equal(fs.readFileSync(file, "utf8"), repaired);
    assert.equal(fs.statSync(file).mtimeMs, unchanged);
  });

test("a managed Codex launch overrides keychain stores and recreates a missing config", (t) => {
  const { accounts, codex } = fixture(t);
  const account = accounts.create({ name: "Keychain", tool: "codex" });
  const file = configFile(accounts.environment(account.id));
  fs.writeFileSync(
    file,
    [
      'mcp_oauth_credentials_store = "keyring"',
      'cli_auth_credentials_store="auto" # inline',
      "[profiles.fast]",
      'mcp_oauth_credentials_store = "keyring"',
      "",
    ].join("\n"),
  );
  accounts.command(account.id, { codex }, false, "yolo");
  const config = assertPinned(file);
  assert.equal(config.profiles.fast.mcp_oauth_credentials_store, "keyring");
  fs.rmSync(file);
  accounts.command(account.id, { codex });
  assertPinned(file);
});

test("a managed Codex launch leaves an unreadable config to Codex itself", (t) => {
  const { accounts, codex } = fixture(t);
  const account = accounts.create({ name: "Broken", tool: "codex" });
  const file = configFile(accounts.environment(account.id));
  fs.writeFileSync(file, "this is = = not toml\n");
  accounts.command(account.id, { codex });
  assert.equal(fs.readFileSync(file, "utf8"), "this is = = not toml\n");
});

test("the owner's local Codex profile is never pinned", (t) => {
  const { root, accounts, codex } = fixture(t);
  const home = path.join(root, ".codex");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "owner"\n');
  const launch = accounts.command("local-codex", { codex });
  assert.equal(launch.env.CODEX_HOME, undefined);
  assert.equal(
    fs.readFileSync(path.join(home, "config.toml"), "utf8"),
    'model = "owner"\n',
  );
  assert.deepEqual(fs.readdirSync(home), ["config.toml"]);
  assert.equal(JSON.stringify(launch.args).includes("credentials_store"), false);
});

const catalog = new ProviderCatalog();
function providerLaunch(t, provider, endpoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-codex-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return prepareProviderLaunch(
    { kind: "managed", tool: "codex", provider },
    { apiKey: "fixture-key-only" },
    { command: "/opt/codex", args: [], env: { PATH: "/bin", HOME: root } },
    { root, catalog, cliVersion: "0.160.1", endpoint },
  );
}

for (const provider of [
  { id: "openrouter", modelId: "anthropic/claude-sonnet-4.6" },
  { id: "zai", modelId: "glm-5.3", responsesAccess: true },
])
  test(`a Codex ${provider.id} launch pins both file credential stores`, (t) => {
    const result = providerLaunch(t, provider);
    assertPinned(configFile(result.env));
    assertPinnedArgs(result.args);
  });

test("a Codex endpoint launch pins both file credential stores", (t) => {
  const endpoint = validateEndpoint({
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
    ],
    lastTest: null,
  });
  const result = providerLaunch(
    t,
    { id: "endpoint", modelId: "qwen3-coder:30b" },
    endpoint,
  );
  assertPinned(configFile(result.env));
  assertPinnedArgs(result.args);
});
