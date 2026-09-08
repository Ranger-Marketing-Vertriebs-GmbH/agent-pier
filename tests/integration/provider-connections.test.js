import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { Doctor } from "../../server/features/operations/doctor.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";
function fixture(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-connections-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const providerCatalog = new ProviderCatalog({ dataDir });
  const connections = new ProviderConnections({ dataDir, providerCatalog });
  const accounts = new AccountStore({
    dataDir,
    home: dataDir,
    providerCatalog,
    providerConnections: connections,
  });
  const access = new ProviderAccess({ accounts, connections, providerCatalog });
  return { dataDir, providerCatalog, connections, accounts, access };
}
test("central credentials are redacted, rotated and removed without provider identity changes", (t) => {
  const { dataDir, connections } = fixture(t);
  const connection = connections.create({
    name: "Shared",
    providerId: "openrouter",
    apiKey: "fixture-key",
  });
  assert.equal(connection.hasSecret, true);
  assert.deepEqual(connection.tools, ["codex", "claude", "opencode"]);
  assert.equal(JSON.stringify(connections.list()).includes("fixture-key"), false);
  assert.equal(
    fs
      .readFileSync(path.join(dataDir, "provider-connections.json"), "utf8")
      .includes("fixture-key"),
    false,
  );
  assert.equal(
    fs.statSync(
      path.join(dataDir, "provider-connection-secrets", `${connection.id}.json`),
    ).mode & 0o777,
    0o600,
  );
  connections.update(connection.id, { name: "Renamed", apiKey: "" });
  assert.equal(connections.secret(connection.id).apiKey, "fixture-key");
  connections.update(connection.id, { apiKey: "rotated-fixture" });
  assert.equal(connections.secret(connection.id).apiKey, "rotated-fixture");
  assert.throws(() => connections.update(connection.id, { providerId: "zai" }));
  assert.throws(() =>
    connections.update(connection.id, { apiKey: "new", removeApiKey: true }),
  );
  assert.throws(() =>
    connections.create({ name: "Bad", providerId: "openrouter", contextTokens: 1000000 }),
  );
  connections.update(connection.id, { removeApiKey: true });
  assert.equal(connections.get(connection.id).hasSecret, false);
  assert.equal(connections.secret(connection.id), null);
  connections.remove(connection.id);
  assert.deepEqual(connections.list(), []);
  assert.throws(() => connections.get(connection.id), { status: 404 });
});
test("generated profiles reuse central keys and retain exact history roots after restart and deletion", async (t) => {
  const { dataDir, providerCatalog, connections, accounts, access } = fixture(t);
  const connection = connections.create({
    name: "Shared",
    providerId: "openrouter",
    apiKey: "shared-fixture",
  });
  const chosen = [];
  for (const tool of ["codex", "claude", "opencode"]) {
    const model = providerCatalog.list({ providerId: "openrouter", tool })[0].modelId;
    const body = { tool, providerConnectionId: connection.id, providerModelId: model };
    const { account, selection } = access.resolve(body);
    assert.equal(account.tool, tool);
    assert.equal(selection.providerConnectionId, connection.id);
    assert.equal(
      accounts.list().some((value) => value.id === account.id),
      false,
    );
    assert.equal(access.resolve(body).account.id, account.id);
    assert.equal(
      fs.existsSync(path.join(accounts.profile(account.id), "secret.json")),
      false,
    );
    assert.throws(() => accounts.update(account.id, { name: "Changed" }), {
      status: 409,
    });
    assert.throws(() => accounts.remove(account.id), { status: 409 });
    assert.throws(() => access.resolve({ accountId: account.id }), { status: 404 });
    const env = accounts.environment(account.id);
    const root = env.CODEX_HOME || env.CLAUDE_CONFIG_DIR || env.XDG_CONFIG_HOME;
    assert.ok(root.startsWith(accounts.profile(account.id) + path.sep));
    const history = new ProviderHistory({ accounts, home: dataDir });
    assert.deepEqual(history.environment({ tool, accountId: account.id }), env);
    await history.close();
    chosen.push({ account, root });
  }
  connections.update(connection.id, { apiKey: "rotation-fixture" });
  assert.equal(
    accounts.environment(chosen[0].account.id).OPENROUTER_API_KEY,
    "rotation-fixture",
  );
  connections.remove(connection.id);
  const restarted = new AccountStore({
    dataDir,
    home: dataDir,
    providerCatalog,
    providerConnections: new ProviderConnections({ dataDir, providerCatalog }),
  });
  for (const { account, root } of chosen) {
    const env = restarted.environment(account.id);
    assert.equal(env.CODEX_HOME || env.CLAUDE_CONFIG_DIR || env.XDG_CONFIG_HOME, root);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.throws(() => restarted.command(account.id, { [account.tool]: "/bin/echo" }), {
      status: 409,
    });
  }
  assert.equal(accounts.environment("local-codex").CODEX_HOME, undefined);
  assert.equal(fs.existsSync(path.join(dataDir, ".codex")), false);
});
test("native account ownership and central provider entitlement are validated before profile creation", (t) => {
  const { connections, accounts, access, providerCatalog } = fixture(t);
  const native = accounts.create({ name: "Native Claude", tool: "claude" });
  assert.equal(
    access.resolve({ accountId: native.id, tool: "claude" }).account.id,
    native.id,
  );
  assert.throws(() => access.resolve({ accountId: native.id, tool: "codex" }));
  assert.throws(() => access.resolve({ accountId: native.id, providerModelId: "model" }));
  const before = accounts.accounts.length;
  assert.throws(() =>
    access.resolve({
      tool: "codex",
      providerConnectionId: "missing",
      providerModelId: "model",
      nativeModelId: "native",
    }),
  );
  assert.equal(accounts.accounts.length, before);
  const connection = connections.create({
    name: "GLM",
    providerId: "zai",
    apiKey: "fixture",
  });
  assert.equal(connection.tools.includes("codex"), false);
  const model = providerCatalog.list({ providerId: "zai", tool: "codex" })[0].modelId;
  const input = {
    tool: "codex",
    providerConnectionId: connection.id,
    providerModelId: model,
  };
  assert.throws(() => access.resolve(input));
  connections.update(connection.id, { responsesAccess: true });
  assert.equal(access.resolve(input).account.provider.responsesAccess, true);
  assert.throws(() => access.resolve({ ...input, accountId: native.id }));
  assert.throws(() => access.resolve({ ...input, tool: "shell" }));
  assert.throws(() => access.resolve(input, { login: true }));
  assert.throws(() => access.resolve({ ...input, providerModelId: "not-in-catalog" }));
  connections.update(connection.id, { removeApiKey: true });
  assert.throws(() => access.resolve(input), { status: 409 });
});

test("doctor checks central key presence without treating generated profiles as missing legacy keys", async (t) => {
  const { dataDir, connections, access, providerCatalog } = fixture(t);
  const connection = connections.create({
    name: "Doctor",
    providerId: "openrouter",
    apiKey: "fixture-key",
  });
  access.resolve({
    tool: "codex",
    providerConnectionId: connection.id,
    providerModelId: providerCatalog.list({ providerId: "openrouter", tool: "codex" })[0]
      .modelId,
  });
  const doctor = new Doctor({
    dataDir,
    command: async () => ({ code: 0, stdout: "fixture 1.0.0" }),
    ptyCheck: async () => true,
  });
  const report = await doctor.run({ scope: "host" });
  assert.equal(
    report.checks.find((check) => check.id === `provider-connection.${connection.id}`)
      .status,
    "ok",
  );
  assert.equal(
    report.checks.some((check) => check.id.startsWith("account.")),
    false,
  );
});
