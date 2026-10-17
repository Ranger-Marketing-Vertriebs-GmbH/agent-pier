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

test("a new managed Codex account seeds both file credential stores", async (t) => {
  const { accounts } = fixture(t);
  const account = accounts.create({ name: "Managed", tool: "codex" });
  assertPinned(configFile(accounts.environment(account.id)));
});

const OVERRIDES = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  'mcp_oauth_credentials_store="file"',
];

for (const [mode, login, expected] of [
  ["default", false, OVERRIDES],
  ["yolo", false, ["--yolo", ...OVERRIDES]],
  ["default", true, ["login", "--device-auth", ...OVERRIDES]],
])
  test(`a managed Codex ${login ? "login" : mode} launch overrides both stores on the command line`, async (t) => {
    // A trusted project's .codex/config.toml outranks CODEX_HOME but not `-c`.
    const { accounts, codex } = fixture(t);
    const account = accounts.create({ name: "Argv", tool: "codex" });
    assert.deepEqual(
      (await accounts.command(account.id, { codex }, login, mode)).args,
      expected,
    );
    assert.deepEqual(accounts.codexCredentialArgs(account.id), OVERRIDES);
  });

test("only managed Codex accounts receive credential store overrides", async (t) => {
  const { accounts } = fixture(t);
  const claude = accounts.create({ name: "Claude", tool: "claude" });
  assert.deepEqual(accounts.codexCredentialArgs("local-codex"), []);
  assert.deepEqual(accounts.codexCredentialArgs(claude.id), []);
});

for (const login of [false, true])
  test(`a managed Codex ${login ? "login" : "work"} launch repairs a missing MCP OAuth pin and keeps the rest`, async (t) => {
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
    fs.writeFileSync(file, legacy, { mode: 0o644 });
    const launch = await accounts.command(account.id, { codex }, login);
    assert.equal(launch.env.CODEX_HOME, path.dirname(file));
    const repaired = fs.readFileSync(file, "utf8");
    const config = assertPinned(file);
    assert.equal(config.model, "gpt-5");
    assert.equal(config.mcp_servers.docs.url, "https://mcp.example/mcp");
    assert.equal(repaired.replace('mcp_oauth_credentials_store = "file"\n', ""), legacy);
    // The repair writes a private file regardless of the previous mode.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const unchanged = fs.statSync(file).mtimeMs;
    await accounts.command(account.id, { codex }, login);
    assert.equal(fs.readFileSync(file, "utf8"), repaired);
    assert.equal(fs.statSync(file).mtimeMs, unchanged);
  });

test("the repair replaces only keychain values and keeps comments and CRLF endings", async (t) => {
  const { accounts, codex } = fixture(t);
  const account = accounts.create({ name: "Keychain", tool: "codex" });
  const file = configFile(accounts.environment(account.id));
  const before = [
    "# owner comment",
    '"mcp_oauth_credentials_store" = "keyring" # team default',
    "cli_auth_credentials_store='auto'",
    "[profiles.fast]",
    'mcp_oauth_credentials_store = "keyring"',
    "",
  ].join("\r\n");
  fs.writeFileSync(file, before);
  await accounts.command(account.id, { codex }, false, "yolo");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    before.replace('"keyring" # team', '"file" # team').replace("'auto'", '"file"'),
  );
  assertPinned(file);
  fs.writeFileSync(file, 'model = "x"\r\n');
  await accounts.command(account.id, { codex });
  assert.equal(
    fs.readFileSync(file, "utf8"),
    'cli_auth_credentials_store = "file"\r\nmcp_oauth_credentials_store = "file"\r\nmodel = "x"\r\n',
  );
  fs.rmSync(file);
  await accounts.command(account.id, { codex });
  assertPinned(file);
});

test("a layout the targeted edit cannot address falls back to a structured rewrite", async (t) => {
  const { accounts, codex } = fixture(t);
  const account = accounts.create({ name: "Bom", tool: "codex" });
  const file = configFile(accounts.environment(account.id));
  fs.writeFileSync(file, '\ufeffmodel = "bom"\n[mcp_servers.docs]\nurl = "https://x"\n');
  await accounts.command(account.id, { codex });
  const config = assertPinned(file);
  assert.equal(config.model, "bom");
  assert.equal(config.mcp_servers.docs.url, "https://x");
});

test("a managed Codex launch leaves an unparseable config to Codex itself", async (t) => {
  const { accounts, codex } = fixture(t);
  const account = accounts.create({ name: "Broken", tool: "codex" });
  const file = configFile(accounts.environment(account.id));
  fs.writeFileSync(file, "this is = = not toml\n");
  await accounts.command(account.id, { codex });
  assert.equal(fs.readFileSync(file, "utf8"), "this is = = not toml\n");
});

test("the repair refuses linked configs and reports unreadable ones", async (t) => {
  const { root, accounts, codex } = fixture(t);
  const account = accounts.create({ name: "Linked", tool: "codex" });
  const file = configFile(accounts.environment(account.id));
  const target = path.join(root, "elsewhere.toml");
  fs.writeFileSync(target, 'model = "outside"\n');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  await assert.rejects(async () => accounts.command(account.id, { codex }), {
    status: 409,
  });
  assert.equal(fs.readFileSync(target, "utf8"), 'model = "outside"\n');
  assert.ok(fs.lstatSync(file).isSymbolicLink());
  fs.rmSync(file);
  fs.writeFileSync(file, 'model = "x"\n', { mode: 0o000 });
  if (process.getuid?.() !== 0)
    await assert.rejects(async () => accounts.command(account.id, { codex }), {
      status: 409,
      message: /Codex-Konfiguration/,
    });
});

test("the owner's local Codex profile is never pinned", async (t) => {
  const { root, accounts, codex } = fixture(t);
  const home = path.join(root, ".codex");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "owner"\n');
  const launch = await accounts.command("local-codex", { codex });
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
  test(`a Codex ${provider.id} launch pins both file credential stores`, async (t) => {
    const result = providerLaunch(t, provider);
    assertPinned(configFile(result.env));
    assertPinnedArgs(result.args);
  });

test("a Codex endpoint launch pins both file credential stores", async (t) => {
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
