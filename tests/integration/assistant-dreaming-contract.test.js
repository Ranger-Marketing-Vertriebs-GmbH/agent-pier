import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
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

/** A compiled native team Gateway (memory-core) with fixture agents. */
async function nativeFixture(t) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-dreaming-contract-"));
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
    connection: { url: "http://127.0.0.1:1", token: "dreaming-fixture" },
    hostMaxConcurrent: 4,
    native: { token: "dreaming-fixture" },
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
test(
  "pinned native dreaming stays off, and once on would ingest AgentPier chats of agents without memory",
  { skip: !installed, timeout: contractTimeout(300000) },
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
