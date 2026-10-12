import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import {
  fixtureModels,
  proactivityModel,
} from "../helpers/assistant-proactivity-model.js";

const installed = process.env.AGENTPIER_PROACTIVITY_CONTRACT_RUNTIME;
const dreamingKey = "memory-core:memory-dreaming-promotion";

/** A compiled native team Gateway (memory-core, Active Memory) with fixture agents. */
async function nativeFixture(t) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-recall-contract-"));
  const descriptor = {
    version: runtimeManifest.version,
    nodePath: path.join(installed, "node/bin/node"),
    entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
  };
  const runtime = new RuntimeSupervisor({ dataDir, install: async () => descriptor });
  const store = new AssistantStore({ dataDir });
  const model = await proactivityModel();
  t.after(async () => {
    try {
      await runtime.close();
      store.close();
      await model.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const plugin = provisionTeamPlugin({
    paths: runtime.paths,
    runtimeVersion: descriptor.version,
  });
  runtime.teamConfiguration = async () => ({
    directory: plugin.directory,
    connection: { url: "http://127.0.0.1:1", token: "recall-fixture" },
    hostMaxConcurrent: 4,
    native: { token: "recall-fixture" },
    profiles: store.listAssistants(),
  });
  await runtime.start();
  const config = new AssistantConfig({
    client: runtime.client,
    store,
    models: fixtureModels(model),
    workspaces: runtime.paths.workspaces,
  });
  config.nativeReady = () => true;
  async function create(name, capabilities) {
    const agent = store.createAssistant({
      name,
      instructions: "",
      model: { connectionId: "fixture", modelId: "fixture-model" },
    });
    store.updateAssistant(agent.id, { capabilities }, agent.revision);
    await config.apply(agent.id);
    return store.getAssistant(agent.id);
  }
  // A conversation as AgentPier opens one; labels are unique per Gateway. The first
  // call after a live apply waits for the plugin reload, so it gets more time.
  async function turn(agent, text) {
    const session = await runtime.client.call(
      "sessions.create",
      {
        agentId: agent.runtimeAgentId,
        label: `AgentPier ${agent.id} ${crypto.randomUUID()}`,
      },
      { timeoutMs: 60000 },
    );
    const offset = model.requests.length;
    const sent = await runtime.client.call(
      "sessions.send",
      { key: session.key, message: text, idempotencyKey: crypto.randomUUID() },
      { timeoutMs: 60000 },
    );
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.equal(done.status, "ok", JSON.stringify(done));
    return model.requests.slice(offset);
  }
  const effective = async () => (await runtime.client.call("config.get", {})).config;
  return { runtime, store, config, model, create, turn, effective };
}
const entryOf = (config, agent) =>
  Array.isArray(config.agents.entries)
    ? config.agents.entries.find((e) => e.id === agent.runtimeAgentId)
    : config.agents.entries?.[agent.runtimeAgentId] ||
      config.agents.list?.find((e) => e.id === agent.runtimeAgentId);
// The Active Memory pass offers only recall tools; a normal turn offers the agent's.
const recallPass = (r) =>
  r.tools?.length > 0 &&
  r.tools.every((tool) => ["memory_search", "memory_get"].includes(tool.function?.name));

test(
  "pinned native recall finds the agent's other conversation and nothing beyond it",
  { skip: !installed, timeout: 300000 },
  async (t) => {
    const f = await nativeFixture(t);
    const recall = await f.create("Recall", {
      memory: true,
      reminders: false,
      recall: true,
    });
    const plain = await f.create("Plain", { memory: true, reminders: false });
    let config = await f.effective();
    assert.deepEqual(config.tools.sessions, { visibility: "agent" });
    assert.equal(config.plugins.entries["active-memory"].enabled, true);
    assert.deepEqual(config.plugins.entries["active-memory"].config.agents, []);
    assert.equal(entryOf(config, recall).memory.search.rememberAcrossConversations, true);
    assert.equal(entryOf(config, plain).memory.search.rememberAcrossConversations, false);

    await f.turn(recall, "My locker code is ZEBRARECALLTOKEN, keep it in mind.");
    await f.turn(plain, "My locker code is OTTERPLAINTOKEN, keep it in mind.");
    // Session indexing runs asynchronously after a turn.
    await delay(8000);
    f.model.searchQuery = "locker code";
    const question = "Do you remember the locker code from our earlier conversation?";
    const recalled = JSON.stringify(await f.turn(recall, question));
    const recallRequests = f.model.requests.filter(recallPass).length;
    assert.ok(recalled.includes("ZEBRARECALLTOKEN"), "recall reaches the other chat");
    assert.ok(!recalled.includes("OTTERPLAINTOKEN"), "never another agent's chat");
    assert.ok(recallRequests > 0, "an Active Memory pass ran before the reply");
    const unrecalled = JSON.stringify(await f.turn(plain, question));
    assert.ok(!unrecalled.includes("OTTERPLAINTOKEN"), "memory alone does not recall");
    assert.ok(!unrecalled.includes("ZEBRARECALLTOKEN"));
    assert.equal(
      f.model.requests.filter(recallPass).length,
      recallRequests,
      "no Active Memory pass for an agent without recall",
    );
    t.diagnostic(`Active Memory requests for one recalled reply: ${recallRequests}.`);

    // Switching recall off applies live and the next start compiles the same.
    f.store.updateAssistant(
      recall.id,
      { capabilities: { memory: true, reminders: false, recall: false } },
      f.store.getAssistant(recall.id).revision,
    );
    await f.config.apply(recall.id);
    config = await f.effective();
    assert.deepEqual(entryOf(config, recall).memory.search.sources, ["memory"]);
    assert.equal(
      entryOf(config, recall).memory.search.rememberAcrossConversations,
      false,
    );
    await f.runtime.stop();
    await f.runtime.start();
    assert.equal(
      entryOf(await f.effective(), recall).memory.search.rememberAcrossConversations,
      false,
    );
  },
);

test(
  "pinned native dreaming stays off, and once on would ingest AgentPier chats of agents without memory",
  { skip: !installed, timeout: 300000 },
  async (t) => {
    const f = await nativeFixture(t);
    const withMemory = await f.create("Dreamer", { memory: true, reminders: false });
    const withoutMemory = await f.create("Forgetful", {
      memory: false,
      reminders: false,
    });
    const dreamingJobs = async () =>
      (
        await f.runtime.client.call("cron.list", { includeDisabled: true, limit: 200 })
      ).jobs.filter((j) => j.declarationKey === dreamingKey);
    assert.deepEqual(await dreamingJobs(), [], "the compiled default schedules no sweep");
    await f.turn(withMemory, "I water the orchids every Sunday DREAMWITHMEMORY.");
    await f.turn(withoutMemory, "I water the ferns every Monday DREAMWITHOUTMEMORY.");

    // What a global switch would do: memory-core's documented dreaming setting.
    const base = await f.runtime.client.call("config.get", {});
    await f.runtime.client.call("config.patch", {
      baseHash: base.hash,
      raw: JSON.stringify({
        plugins: {
          entries: { "memory-core": { config: { dreaming: { enabled: true } } } },
        },
      }),
    });
    let job;
    for (let n = 0; n < 60 && !job; n++) {
      [job] = await dreamingJobs();
      if (!job) await delay(500);
    }
    assert.ok(job, "enabling dreaming schedules memory-core's sweep");
    assert.equal(job.schedule.expr, "0 3 * * *");
    await f.runtime.client.call("cron.run", { id: job.id, mode: "force" });
    const deadline = Date.now() + 90000;
    let runs = [];
    while (Date.now() < deadline) {
      runs = (await f.runtime.client.call("cron.runs", { id: job.id, limit: 5 })).entries;
      if (runs.some((r) => r.action === "finished")) break;
      await delay(500);
    }
    assert.ok(
      runs.some((r) => r.status === "ok"),
      JSON.stringify(runs),
    );
    const corpus = (agent) => {
      const dir = path.join(
        f.runtime.paths.workspaces,
        agent.id,
        "memory",
        ".dreams",
        "session-corpus",
      );
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
            .join("\n")
        : "";
    };
    // AgentPier-origin sessions count as interactive: dreaming does process them.
    assert.match(corpus(withMemory), /DREAMWITHMEMORY/);
    // The sweep covers every configured agent workspace, memory capability or not.
    // This is why AgentPier ships no dreaming switch (docs/assistant-gateway.md).
    assert.match(corpus(withoutMemory), /DREAMWITHOUTMEMORY/);
    t.diagnostic(
      "Dreaming copied transcripts of the agent without memory into its workspace; no per-agent scope exists in 2026.9.8.",
    );
  },
);
