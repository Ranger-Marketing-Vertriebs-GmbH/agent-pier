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
