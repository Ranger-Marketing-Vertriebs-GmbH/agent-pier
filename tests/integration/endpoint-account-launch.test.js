import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { parse as parseToml } from "smol-toml";

const model = (modelId, contextTokens) => ({
  modelId,
  label: modelId,
  contextTokens,
  outputTokens: null,
  source: "manual",
  contextEdited: true,
});
const endpoint = {
  preset: "custom",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: true, chatCompletions: true },
  authHeader: null,
  models: [model("qwen3", 32768), model("llama", 65536)],
  lastTest: null,
};

function setup(t, { apiKey } = {}) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-account-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const providerCatalog = new ProviderCatalog({ dataDir });
  const connections = new ProviderConnections({ dataDir });
  const accounts = new AccountStore({
    dataDir,
    home: dataDir,
    providerCatalog,
    providerConnections: connections,
  });
  const access = new ProviderAccess({ accounts, connections, providerCatalog });
  const connection = connections.create({
    name: "GPU box",
    providerId: "endpoint",
    endpoint,
    ...(apiKey ? { apiKey } : {}),
  });
  const executable = path.join(dataDir, "version-fixture");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '2.2.0\\n'\n", { mode: 0o755 });
  const resolve = (tool, providerModelId = "qwen3") =>
    access.resolve({ tool, providerConnectionId: connection.id, providerModelId })
      .account;
  return { dataDir, accounts, connections, connection, executable, resolve };
}

for (const tool of ["claude", "codex", "opencode"])
  test(`${tool} endpoint account launches through the account store`, (t) => {
    const { accounts, connection, executable, resolve } = setup(t, {
      apiKey: "endpoint-private-key",
    });
    const account = resolve(tool);
    assert.deepEqual(
      accounts.endpointFor(account),
      accounts.providerConnections.record(connection.id).endpoint,
    );
    const launch = accounts.command(account.id, { [tool]: executable });
    assert.equal(launch.provider.modelChangeRequiresRestart, true);
    assert.equal(launch.provider.assumedContextTokens, 32768);
    assert.equal(JSON.stringify(launch.args).includes("endpoint-private-key"), false);
    if (tool === "claude") {
      assert.equal(launch.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
      assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, "endpoint-private-key");
    } else assert.equal(launch.env.AGENTPIER_ENDPOINT_API_KEY, "endpoint-private-key");
    if (tool === "opencode") {
      const config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.provider["agentpier-endpoint"].name, "GPU box");
    }
    if (tool === "codex") {
      const config = parseToml(
        fs.readFileSync(path.join(launch.env.CODEX_HOME, "config.toml"), "utf8"),
      );
      assert.equal(config.model_providers["agentpier-endpoint"].name, "GPU box");
    }
    const switched = accounts.command(
      account.id,
      { [tool]: executable },
      false,
      "default",
      { modelId: "llama" },
    );
    assert.equal(switched.provider.modelId, "llama");
    assert.equal(switched.provider.assumedContextTokens, 65536);
    assert.throws(
      () =>
        accounts.command(account.id, { [tool]: executable }, false, "default", {
          modelId: "unknown",
        }),
      { status: 409 },
    );
  });

test("endpoint environment survives a removed connection; launch refuses it", (t) => {
  const { accounts, connections, connection, executable, resolve } = setup(t);
  const account = resolve("claude");
  connections.remove(connection.id);
  const env = accounts.environment(account.id);
  assert.ok(env.CLAUDE_CONFIG_DIR);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.throws(() => accounts.command(account.id, { claude: executable }), {
    status: 404,
  });
});

test("endpointFor ignores catalog accounts and rejects endpoint accounts without a connection", (t) => {
  const { accounts } = setup(t);
  assert.equal(
    accounts.endpointFor({ provider: { id: "zai", modelId: "x" } }),
    undefined,
  );
  assert.equal(accounts.endpointFor({ tool: "codex" }), undefined);
  assert.throws(
    () => accounts.endpointFor({ provider: { id: "endpoint", modelId: "qwen3" } }),
    { status: 400 },
  );
});

test("legacy per-account profiles still reject the endpoint provider", (t) => {
  const { accounts } = setup(t);
  assert.throws(
    () =>
      accounts.create({
        name: "Direct",
        tool: "codex",
        provider: { id: "endpoint", modelId: "qwen3" },
      }),
    { status: 400 },
  );
  const created = accounts.create({ name: "Plain", tool: "codex" });
  assert.throws(
    () => accounts.update(created.id, { provider: { id: "endpoint", modelId: "qwen3" } }),
    { status: 400 },
  );
});
