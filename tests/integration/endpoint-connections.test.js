import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { applicationFixture } from "../helpers/application.js";
import { McpTools } from "../../server/features/mcp/tool-service.js";
import { Doctor } from "../../server/features/operations/doctor.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { profileConnection } from "../../server/features/pipelines/profile-validation.js";

export const ollama = {
  preset: "ollama",
  openaiBaseUrl: "http://127.0.0.1:11434/v1",
  anthropicBaseUrl: "http://127.0.0.1:11434",
  protocols: { messages: true, responses: true, chatCompletions: true },
  authHeader: null,
  models: [
    {
      modelId: "qwen3",
      label: "qwen3",
      contextTokens: 32768,
      outputTokens: null,
      source: "detected",
      contextEdited: false,
    },
  ],
  lastTest: null,
};
function store(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, connections: new ProviderConnections({ dataDir }) };
}

test("keyless endpoint connection is launchable and exposes its tools", (t) => {
  const { connections } = store(t);
  const created = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  assert.equal(created.hasSecret, false);
  assert.equal(created.launchable, true);
  assert.deepEqual(created.tools, ["codex", "claude", "opencode"]);
  assert.equal(created.endpoint.models[0].modelId, "qwen3");
  assert.equal(created.responsesAccess, undefined);
  assert.equal(connections.record(created.id).endpoint.preset, "ollama");
});

test("catalog connections without key are not launchable", (t) => {
  const { connections } = store(t);
  assert.equal(
    connections.create({ name: "R", providerId: "openrouter" }).launchable,
    false,
  );
  assert.throws(
    () => connections.create({ name: "R", providerId: "openrouter", endpoint: ollama }),
    { status: 400 },
  );
});

test("endpoint connections require an endpoint block and catalog ones reject it on update", (t) => {
  const { connections } = store(t);
  assert.throws(() => connections.create({ name: "E", providerId: "endpoint" }), {
    status: 400,
  });
  const { id } = connections.create({ name: "R", providerId: "openrouter" });
  assert.throws(() => connections.update(id, { endpoint: ollama }), { status: 400 });
});

test("changing the origin requires key re-entry or removal", (t) => {
  const { connections } = store(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
    apiKey: "secret-1",
  });
  const moved = {
    ...ollama,
    openaiBaseUrl: "http://10.0.0.9:11434/v1",
    anthropicBaseUrl: "http://10.0.0.9:11434",
  };
  assert.throws(() => connections.update(id, { endpoint: moved }), { status: 409 });
  assert.equal(connections.secret(id).apiKey, "secret-1");
  // Path-only change keeps the key.
  connections.update(id, {
    endpoint: { ...ollama, openaiBaseUrl: "http://127.0.0.1:11434/api/v1" },
  });
  assert.equal(connections.secret(id).apiKey, "secret-1");
  connections.update(id, { endpoint: moved, apiKey: "secret-2" });
  assert.equal(connections.secret(id).apiKey, "secret-2");
  connections.update(id, { endpoint: ollama, removeApiKey: true });
  assert.equal(connections.secret(id), null);
});

test("invalid stored endpoint records are skipped, not fatal, and preserved on save", (t) => {
  const { dataDir, connections } = store(t);
  const good = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const file = path.join(dataDir, "provider-connections.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  const badId = "00000000-0000-4000-8000-000000000000";
  const bad = { ...records[0], id: badId, endpoint: { preset: "bad" } };
  records.push(bad);
  fs.writeFileSync(file, JSON.stringify(records));
  const reloaded = new ProviderConnections({ dataDir });
  assert.deepEqual(
    reloaded.list().map((item) => item.id),
    [good.id],
  );
  assert.deepEqual(reloaded.invalid, [badId]);
  reloaded.update(good.id, { name: "Renamed" });
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    saved.find((record) => record.id === badId),
    bad,
  );
  assert.equal(saved.length, 2);
});

function full(t) {
  const { dataDir, connections } = store(t);
  const providerCatalog = new ProviderCatalog({ dataDir });
  const accounts = new AccountStore({
    dataDir,
    home: dataDir,
    providerCatalog,
    providerConnections: connections,
  });
  return {
    connections,
    accounts,
    access: new ProviderAccess({ accounts, connections, providerCatalog }),
  };
}

test("keyless endpoint resolves to an internal account with only id and model", (t) => {
  const { connections, access } = full(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const resolved = access.resolve({
    tool: "claude",
    providerConnectionId: id,
    providerModelId: "qwen3",
  });
  assert.deepEqual(resolved.account.provider, { id: "endpoint", modelId: "qwen3" });
  assert.equal(resolved.selection.providerId, "endpoint");
  assert.throws(
    () =>
      access.resolve({
        tool: "claude",
        providerConnectionId: id,
        providerModelId: "nope",
      }),
    { status: 409 },
  );
});

test("endpoint pipeline snapshot covers origins, protocols and selected model limits only", (t) => {
  const { connections, accounts } = full(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const snapshot = profileConnection(
    { providerConnectionId: id, cliTool: "opencode", models: { available: ["qwen3"] } },
    accounts,
  );
  assert.deepEqual(snapshot, {
    id,
    providerId: "endpoint",
    endpoint: {
      origins: ["http://127.0.0.1:11434"],
      protocols: ollama.protocols,
      models: { qwen3: { contextTokens: 32768, outputTokens: null } },
    },
  });
  connections.update(id, {
    endpoint: {
      ...ollama,
      lastTest: {
        at: new Date().toISOString(),
        protocols: { messages: "ok", responses: "ok", chatCompletions: "ok" },
        reasons: {},
      },
    },
  });
  assert.deepEqual(
    profileConnection(
      { providerConnectionId: id, cliTool: "opencode", models: { available: ["qwen3"] } },
      accounts,
    ),
    snapshot,
  );
});

test("pre-launch target check refuses http to public resolution", async (t) => {
  const { connections, access, accounts } = full(t);
  const { id } = connections.create({
    name: "Remote",
    providerId: "endpoint",
    endpoint: {
      ...ollama,
      openaiBaseUrl: "http://llm.example/v1",
      anthropicBaseUrl: "http://llm.example",
    },
  });
  const { account } = access.resolve({
    tool: "opencode",
    providerConnectionId: id,
    providerModelId: "qwen3",
  });
  await assert.rejects(
    accounts.verifyEndpointTarget(account.id, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
    { status: 400 },
  );
  await accounts.verifyEndpointTarget(account.id, {
    lookup: async () => [{ address: "192.168.1.20", family: 4 }],
  });
  await accounts.verifyEndpointTarget("local-codex");
});

test("MCP models_list returns only endpoint models with a context window", async (t) => {
  const app = await applicationFixture(t);
  const { providerConnections } = app.application;
  const { id } = providerConnections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: {
      ...ollama,
      models: [
        ...ollama.models,
        {
          ...ollama.models[0],
          modelId: "nocontext",
          label: "nocontext",
          contextTokens: null,
        },
      ],
    },
  });
  const tools = new McpTools(app.application);
  t.after(() => tools.close());
  const result = await tools.call(
    "models_list",
    { connectionId: id, tool: "opencode" },
    {
      id: "g",
      clientId: "c",
      scopes: ["catalog:read"],
      projectIds: [],
      accountIds: ["local-opencode"],
      connectionIds: [id],
    },
  );
  assert.deepEqual(
    result.items.map(({ modelId, name, contextTokens }) => ({
      modelId,
      name,
      contextTokens,
    })),
    [{ modelId: "qwen3", name: "qwen3", contextTokens: 32768 }],
  );
});

test("doctor reports keyless endpoints with test state and models lacking context", async (t) => {
  const { dataDir, connections } = store(t);
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: {
      ...ollama,
      models: [{ ...ollama.models[0], contextTokens: null }],
    },
  });
  const run = () =>
    new Doctor({
      dataDir,
      command: async () => ({ code: 0, stdout: "fixture 1.0.0" }),
      ptyCheck: async () => true,
    }).run({ scope: "host" });
  const check = async () =>
    (await run()).checks.find((entry) => entry.id === `provider-connection.${id}`);
  let found = await check();
  assert.equal(found.status, "warn");
  assert.match(found.summary, /never tested/);
  assert.match(found.summary, /1 model\(s\) without context/);
  connections.update(id, {
    endpoint: {
      ...ollama,
      lastTest: {
        at: "2026-10-06T00:00:00.000Z",
        protocols: { messages: "ok", responses: "ok", chatCompletions: "failed" },
        reasons: {},
      },
    },
  });
  found = await check();
  assert.equal(found.status, "ok");
  assert.match(
    found.summary,
    /last test 2026-10-06T00:00:00.000Z: messages=ok, responses=ok, chatCompletions=failed/,
  );
});

test("restore never flags keyless endpoint connections for login", async (t) => {
  const { dataDir, connections } = store(t);
  const endpoint = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: ollama,
  });
  const keyed = connections.create({ name: "R", providerId: "openrouter", apiKey: "k" });
  const backup = await new Backup({ dataDir }).create({});
  const target = path.join(dataDir, "..", `${path.basename(dataDir)}-restored`);
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const report = await new Restore({ dataDir }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  assert.equal(report.credentialsNeedingLogin.includes(`provider:${endpoint.id}`), false);
  assert.equal(report.credentialsNeedingLogin.includes(`provider:${keyed.id}`), true);
});
