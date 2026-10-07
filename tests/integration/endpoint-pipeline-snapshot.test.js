import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderAccess } from "../../server/features/providers/provider-access.js";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { profileConnection } from "../../server/features/pipelines/profile-validation.js";
import { validateProfileLaunch } from "../../server/features/pipelines/native-profile.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

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
  anthropicBaseUrl: "http://127.0.0.1:11435",
  protocols: { messages: true, responses: true, chatCompletions: true },
  authHeader: null,
  models: [model("qwen3", 32768), model("llama", 65536)],
  lastTest: null,
};
const changed = {
  status: 409,
  message: serverMessages.pipelineProfiles.providerConfigurationChanged,
};

function setup(t, tool, available = ["qwen3", "llama"], endpointOverrides = {}) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-endpoint-snapshot-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const connections = new ProviderConnections({ dataDir });
  const providerCatalog = new ProviderCatalog({ dataDir });
  const accounts = new AccountStore({
    dataDir,
    home: dataDir,
    providerCatalog,
    providerConnections: connections,
  });
  const access = new ProviderAccess({ accounts, connections, providerCatalog });
  const { id } = connections.create({
    name: "GPU",
    providerId: "endpoint",
    endpoint: { ...endpoint, ...endpointOverrides },
  });
  const config = {
    accountId: `local-${tool}`,
    cliTool: tool,
    providerConnectionId: id,
    models: { available, default: available[0] },
  };
  const profile = {
    config,
    providerConnectionSnapshot: profileConnection(config, accounts),
  };
  const launch = (modelId = available[0]) => {
    const { account } = access.resolve({
      tool,
      providerConnectionId: id,
      providerModelId: modelId,
    });
    validateProfileLaunch(profile, account, accounts, modelId);
  };
  const edit = (patch) =>
    connections.update(id, { endpoint: { ...endpoint, ...endpointOverrides, ...patch } });
  return { profile, launch, edit };
}

test("endpoint snapshot keeps only the protocol and origin the profile's CLI uses", (t) => {
  const opencode = setup(t, "opencode").profile.providerConnectionSnapshot.endpoint;
  assert.deepEqual(opencode, {
    origins: ["http://127.0.0.1:11434"],
    protocols: { chatCompletions: true },
    route: { mode: "native", source: "chatCompletions" },
    models: {
      qwen3: { contextTokens: 32768, outputTokens: null },
      llama: { contextTokens: 65536, outputTokens: null },
    },
  });
  const claude = setup(t, "claude", ["qwen3"]).profile.providerConnectionSnapshot
    .endpoint;
  assert.deepEqual(claude.origins, ["http://127.0.0.1:11435"]);
  assert.deepEqual(claude.protocols, { messages: true });
});

test("pipeline launch accepts unrelated endpoint edits and a re-test", (t) => {
  const { launch, edit } = setup(t, "opencode");
  launch();
  launch("llama");
  edit({
    lastTest: {
      at: new Date().toISOString(),
      protocols: { messages: "ok", responses: "failed", chatCompletions: "ok" },
      reasons: { responses: "timeout" },
    },
  });
  launch();
  // Another model's limits, other protocols and the Anthropic URL are not used here.
  edit({
    models: [model("qwen3", 32768), model("llama", 131072)],
    protocols: { messages: false, responses: false, chatCompletions: true },
    anthropicBaseUrl: "http://127.0.0.1:9999",
  });
  launch();
});

test("pipeline launch refuses relevant endpoint changes", (t) => {
  const context = setup(t, "opencode");
  context.edit({ models: [model("qwen3", 16384), model("llama", 65536)] });
  assert.throws(() => context.launch(), changed);
  context.edit({ openaiBaseUrl: "http://127.0.0.1:8080/v1" });
  assert.throws(() => context.launch(), changed);
  context.edit({
    protocols: { messages: true, responses: true, chatCompletions: false },
  });
  assert.throws(() => context.launch());
  const claude = setup(t, "claude");
  claude.edit({ anthropicBaseUrl: "http://127.0.0.1:9999" });
  assert.throws(() => claude.launch(), changed);
});

test("pipeline launch refuses a model the snapshot does not contain", (t) => {
  const { launch } = setup(t, "opencode", ["qwen3"]);
  launch();
  assert.throws(() => launch("llama"), changed);
});

test("snapshots freeze an explicit adapter route and its source origin", (t) => {
  const { profile, launch, edit } = setup(t, "claude", ["qwen3"], {
    protocols: { messages: false, responses: true, chatCompletions: true },
    routing: { claude: "adapter:chatCompletions" },
  });
  assert.deepEqual(profile.providerConnectionSnapshot.endpoint.route, {
    mode: "adapter",
    source: "chatCompletions",
  });
  assert.deepEqual(profile.providerConnectionSnapshot.endpoint.origins, [
    "http://127.0.0.1:11434",
  ]);
  launch();
  edit({
    protocols: { messages: false, responses: true, chatCompletions: true },
    routing: { claude: "adapter:responses" },
  });
  assert.throws(() => launch(), changed); // route moved to adapter:responses
});

test("legacy snapshots without a route keep launching while the route is native (Review Focus 3)", (t) => {
  const { profile, launch, edit } = setup(t, "codex");
  delete profile.providerConnectionSnapshot.endpoint.route;
  launch();
  edit({
    protocols: { messages: false, responses: false, chatCompletions: true },
    routing: { codex: "adapter:chatCompletions" },
  });
  assert.throws(() => launch(), changed);
});

test("a legacy snapshot still refuses an origin change", (t) => {
  const { profile, launch, edit } = setup(t, "codex");
  delete profile.providerConnectionSnapshot.endpoint.route;
  edit({ openaiBaseUrl: "http://127.0.0.1:8080/v1" });
  assert.throws(() => launch(), changed);
});

test("a route-less opencode snapshot is refused once auto resolves to an sdk route", (t) => {
  const { profile, launch, edit } = setup(t, "opencode");
  delete profile.providerConnectionSnapshot.endpoint.route;
  launch();
  edit({ protocols: { messages: false, responses: true, chatCompletions: false } });
  assert.throws(() => launch(), changed);
});

test("opencode sdk routes are frozen with mode, source and origin", (t) => {
  const { profile } = setup(t, "opencode", ["qwen3"], {
    protocols: { messages: false, responses: true, chatCompletions: false },
  });
  const frozen = profile.providerConnectionSnapshot.endpoint;
  assert.deepEqual(frozen.route, { mode: "sdk", source: "responses" });
  assert.deepEqual(frozen.protocols, { responses: true });
  assert.deepEqual(frozen.origins, ["http://127.0.0.1:11434"]);
});

test("auto never moves a pipeline onto an adapter route in PR 2", (t) => {
  const { launch, edit } = setup(t, "codex");
  edit({ protocols: { messages: false, responses: false, chatCompletions: true } });
  // ProviderAccess.resolve refuses with connectionToolUnsupported: codex is no longer offered
  assert.throws(() => launch(), { status: 400 });
});
