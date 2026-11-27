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

// A stopped Gateway: the provider preparation of a start writes each agent's model
// with its fallback models (runtimeOptions.openclaw.fallbacks) and prepares every
// provider a fallback needs exactly as the agent's own.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-fallbacks-"));
  const paths = runtimePaths(dataDir);
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const connections = new ProviderConnections({ dataDir });
  const router = (name) =>
    connections.create({ name, providerId: "openrouter", apiKey: `${name}-fixture-key` });
  const own = router("own");
  const spare = router("spare");
  const second = router("second");
  // The provider catalog prices one model, as OpenRouter lists it.
  const catalog = {
    get(providerId, modelId) {
      if (providerId !== "openrouter" || modelId !== "vendor/small")
        throw Error("not in catalog");
      return { pricing: { inputPerMTok: 0.5, outputPerMTok: 2 } };
    },
  };
  const models = new AssistantModels({ connections, catalog });
  const create = (name, fallbacks, model = { connectionId: own.id, modelId: "chat" }) =>
    store.createAssistant({
      name,
      instructions: "",
      model,
      capabilities: { memory: false, reminders: false },
      ...(fallbacks && { runtimeOptions: { openclaw: { fallbacks } } }),
    });
  const prepare = async () => {
    const entries = Object.fromEntries(
      store.listAssistants().map((agent) => [agent.runtimeAgentId, {}]),
    );
    writePrivate(paths.config, {
      tools: { allow: ["session_status"] },
      agents: { defaults: {}, entries },
      models: { providers: { [`ap-${spare.id}-stale`]: { apiKey: "stale" } } },
    });
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
    });
    await sync.prepare();
    return { sync, config: readJSON(paths.config) };
  };
  const model = (config, agent) => config.agents.entries[agent.runtimeAgentId].model;
  return { store, connections, own, spare, second, create, prepare, model };
}
const provider = (ref) => ref.split("/")[0];

test("a start writes an agent's fallbacks in order, each with its provider", async (t) => {
  const f = fixture(t);
  const agent = f.create("Backed", [
    { connectionId: f.spare.id, modelId: "vendor/small" },
    { connectionId: f.second.id, modelId: "other" },
  ]);
  const plain = f.create("Plain");
  const { sync, config } = await f.prepare();
  const { primary, fallbacks } = f.model(config, agent);
  assert.ok(primary.startsWith(`ap-${f.own.id}-`));
  assert.equal(fallbacks.length, 2);
  assert.ok(fallbacks[0].startsWith(`ap-${f.spare.id}-`));
  assert.ok(fallbacks[0].endsWith("/vendor/small"));
  assert.ok(fallbacks[1].startsWith(`ap-${f.second.id}-`));
  // Each fallback's key reaches only its own compiled provider; a stale provider of
  // a fallback's connection goes like one of a model's.
  const providers = config.models.providers;
  assert.equal(providers[provider(fallbacks[0])].apiKey, "spare-fixture-key");
  assert.equal(providers[provider(fallbacks[1])].apiKey, "second-fixture-key");
  assert.equal(providers[provider(primary)].apiKey, "own-fixture-key");
  assert.equal(providers[`ap-${f.spare.id}-stale`], undefined);
  assert.equal(Object.keys(providers).length, 3);
  // A fallback is priced like a primary (assistant-models.js), so a turn it answers
  // is not reported as unpriced (openclaw-usage.js); a model without a price has none.
  assert.deepEqual(providers[provider(fallbacks[0])].models[0].cost, {
    input: 0.5,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 0.5,
  });
  assert.equal("cost" in providers[provider(fallbacks[1])].models[0], false);
  // An agent without fallbacks keeps OpenClaw's strict empty list.
  assert.deepEqual(f.model(config, plain).fallbacks, []);
  assert.equal(sync.blocked.size, 0);
  // A fallback's connection counts as used: changing it restarts the Gateway.
  assert.equal(sync.affects(f.spare.id), true);
  assert.deepEqual(sync.usage(f.spare.id).agents, [{ id: agent.id, name: "Backed" }]);
});

test("a fallback that cannot serve is left out, never a blocked agent", async (t) => {
  const f = fixture(t);
  const agent = f.create("Backed", [
    { connectionId: f.spare.id, modelId: "small" },
    { connectionId: f.second.id, modelId: "other" },
  ]);
  // Its connection was deleted, the other one lost its key... the second stays.
  f.connections.remove(f.spare.id);
  const { sync, config } = await f.prepare();
  const { primary, fallbacks } = f.model(config, agent);
  assert.ok(primary.startsWith(`ap-${f.own.id}-`));
  assert.equal(fallbacks.length, 1);
  assert.ok(fallbacks[0].startsWith(`ap-${f.second.id}-`));
  assert.equal(sync.blocked.has(agent.id), false);
  assert.equal(
    Object.keys(config.models.providers).some((key) => key.includes(f.spare.id)),
    false,
  );
});

test("an agent whose own model is gone is blocked and gets no fallback", async (t) => {
  const f = fixture(t);
  const agent = f.create("Backed", [{ connectionId: f.spare.id, modelId: "small" }]);
  f.connections.remove(f.own.id);
  const { sync, config } = await f.prepare();
  assert.deepEqual(f.model(config, agent), {
    primary: "agentpier-unavailable/blocked",
    fallbacks: [],
  });
  assert.equal(sync.blocked.has(agent.id), true);
});

test("the agent's own model and a repeated one are never its fallbacks", async (t) => {
  const f = fixture(t);
  // Stored before its model was changed to the same one (the write refuses it).
  const agent = f.create(
    "Same",
    [
      { connectionId: f.spare.id, modelId: "small" },
      { connectionId: f.second.id, modelId: "other" },
    ],
    { connectionId: f.spare.id, modelId: "small" },
  );
  const { config } = await f.prepare();
  const { primary, fallbacks } = f.model(config, agent);
  assert.ok(primary.endsWith("/small"));
  assert.equal(fallbacks.length, 1);
  assert.ok(fallbacks[0].startsWith(`ap-${f.second.id}-`));
});
