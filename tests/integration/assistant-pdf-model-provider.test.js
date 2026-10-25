import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { PdfPolicy } from "../../server/features/assistants/pdf-policy.js";

// A stopped Gateway whose start compiled `pdf` for an agent that reads PDFs; the
// provider preparation then adds the owner's PDF fallback before the Gateway runs.
function fixture(t, { offered = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-pdf-model-"));
  const paths = runtimePaths(dataDir);
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const connections = new ProviderConnections({ dataDir });
  const own = connections.create({
    name: "Chat",
    providerId: "openrouter",
    apiKey: "chat-fixture-key",
  });
  const reading = connections.create({
    name: "Vision",
    providerId: "openrouter",
    apiKey: "vision-fixture-key",
  });
  const models = new AssistantModels({ connections });
  const agent = store.createAssistant({
    name: "Reader",
    instructions: "",
    model: { connectionId: own.id, modelId: "chat" },
    capabilities: { memory: false, reminders: false, readPdfs: true },
  });
  const allow = ["session_status", ...(offered ? ["pdf"] : [])];
  writePrivate(paths.config, {
    tools: { allow },
    agents: {
      defaults: {},
      entries: { [agent.runtimeAgentId]: { id: agent.runtimeAgentId, tools: { allow } } },
    },
    models: { providers: { [`ap-${reading.id}-stale`]: { apiKey: "stale" } } },
  });
  let selection = { connectionId: reading.id, modelId: "vision" };
  const assistants = {
    store,
    models,
    runtime: { paths, client: { ready: false } },
    config: { reset() {} },
  };
  const sync = new AssistantProviderSynchronization({
    assistants,
    connections,
    maintenance: {},
    pdfModel: () => selection,
  });
  return {
    paths,
    sync,
    agent,
    own,
    reading,
    connections,
    store,
    choose: (value) => {
      selection = value;
    },
  };
}

test("a start that offers pdf compiles the owner's PDF fallback with its provider", async (t) => {
  const { paths, sync, reading, agent } = fixture(t);
  await sync.prepare();
  const config = readJSON(paths.config);
  const { primary, fallbacks } = config.agents.defaults.pdfModel;
  assert.deepEqual(fallbacks, []);
  const [providerId, modelId] = primary.split("/");
  assert.equal(modelId, "vision");
  assert.ok(providerId.startsWith(`ap-${reading.id}-`));
  // The key reaches only the compiled provider; the stale one of that connection goes.
  assert.equal(config.models.providers[providerId].apiKey, "vision-fixture-key");
  assert.equal(config.models.providers[`ap-${reading.id}-stale`], undefined);
  assert.ok(config.tools.allow.includes("pdf"));
  assert.ok(config.agents.entries[agent.runtimeAgentId].tools.allow.includes("pdf"));
  // The tool guard reads text-only agents' PDFs with the fallback this start runs.
  assert.equal(sync.pdfFallback, primary);
});

test("without a usable fallback pdf stays with a placeholder that never resolves", async (t) => {
  for (const broken of [null, "deleted"]) {
    const { paths, sync, agent, reading, connections, choose } = fixture(t);
    if (broken === "deleted") connections.remove(reading.id);
    else choose(null);
    await sync.prepare();
    const config = readJSON(paths.config);
    // Explicit, without fallbacks: OpenClaw never picks another configured model.
    assert.deepEqual(config.agents.defaults.pdfModel, {
      primary: "agentpier-unavailable/blocked",
      fallbacks: [],
    });
    assert.equal(
      Object.keys(config.models.providers).some((key) => key.startsWith("agentpier")),
      false,
    );
    assert.ok(config.tools.allow.includes("pdf"));
    assert.ok(config.agents.entries[agent.runtimeAgentId].tools.allow.includes("pdf"));
    assert.equal(sync.pdfFallback, null);
  }
});

test("a start that offers no pdf compiles no PDF model", async (t) => {
  const { paths, sync } = fixture(t, { offered: false });
  sync.pdfFallback = "stale/model";
  await sync.prepare();
  assert.equal(readJSON(paths.config).agents.defaults.pdfModel, undefined);
  assert.equal(sync.pdfFallback, null);
});

test("the PDF model's connection counts as used by agents that read PDFs", (t) => {
  const { sync, reading, own, agent, choose } = fixture(t);
  assert.equal(sync.affects(reading.id), true);
  assert.deepEqual(sync.usage(reading.id).agents, [{ id: agent.id, name: "Reader" }]);
  assert.equal(sync.affects(own.id), true);
  choose(null);
  assert.equal(sync.affects(reading.id), false);
});

test("the tool guard's model is the reference the start compiled; a changed provider fails closed", async (t) => {
  const { paths, sync, connections, store } = fixture(t);
  const endpoint = (url) => ({
    preset: "custom",
    openaiBaseUrl: url,
    authHeader: null,
    protocols: { messages: false, responses: false, chatCompletions: true },
    models: [
      {
        modelId: "vl",
        source: "manual",
        contextTokens: 32768,
        outputTokens: 4096,
        images: true,
      },
    ],
  });
  const vision = connections.create({
    providerId: "endpoint",
    name: "Local",
    endpoint: endpoint("http://127.0.0.1:9/v1"),
  });
  const agent = store.createAssistant({
    name: "Viewer",
    instructions: "",
    model: { connectionId: vision.id, modelId: "vl" },
    capabilities: { memory: false, reminders: false, readPdfs: true },
  });
  const config = readJSON(paths.config);
  config.agents.entries[agent.runtimeAgentId] = {
    id: agent.runtimeAgentId,
    tools: { allow: ["pdf"] },
  };
  writePrivate(paths.config, config);
  await sync.prepare();
  const compiled = readJSON(paths.config);
  const policy = new PdfPolicy({
    assistants: { store, models: sync.assistants.models, providerSynchronization: sync },
  });
  // The same AssistantModels resolves the same transport: the ref the Gateway runs.
  const { primary } = compiled.agents.entries[agent.runtimeAgentId].model;
  assert.deepEqual(await policy.check({ agentId: agent.runtimeAgentId }), {
    allow: true,
    model: primary,
  });
  // A provider change waiting for its restart gets a new transport the Gateway does
  // not know: with an explicit PDF model without fallbacks OpenClaw fails the call
  // ("Unknown model") instead of reaching another provider.
  connections.update(vision.id, { endpoint: endpoint("http://127.0.0.1:10/v1") });
  const changed = await policy.check({ agentId: agent.runtimeAgentId });
  assert.equal(changed.allow, true);
  assert.notEqual(changed.model, primary);
  assert.equal(compiled.models.providers[changed.model.split("/")[0]], undefined);
  assert.deepEqual(compiled.agents.defaults.pdfModel.fallbacks, []);
});
