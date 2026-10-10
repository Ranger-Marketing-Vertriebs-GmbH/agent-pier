import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { assistantProviderServer } from "../helpers/assistant-provider-server.js";
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;

test(
  "native scheduled work rotates credentials and cannot use a removed connection after restart",
  {
    skip: !installed,
    timeout: 240000,
  },
  async (t) => {
    assert.ok(path.isAbsolute(installed));
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "assistant-provider-schedule-"),
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir }),
      server = await assistantProviderServer();
    const connections = new ProviderConnections({ dataDir }),
      models = new AssistantModels({ connections });
    const config = new AssistantConfig({
      client: { call: (...args) => runtime.client.call(...args) },
      models,
      store,
      workspaces: runtime.paths.workspaces,
    });
    const assistants = {
      store,
      models,
      runtime,
      config,
      maintenance: false,
      changed() {},
      requireReady() {
        assert.ok(runtime.client?.ready);
      },
    };
    const reminders = new NativeReminders({
      assistants,
      channels: { outbox: { all: () => [] } },
      dataDir,
    });
    assistants.reminders = reminders;
    const maintenance = {
      enter: async () => {
        assistants.maintenance = true;
      },
      blockers: async () => [],
      quiesce: async () => {},
      leave: async () => {
        assistants.maintenance = false;
      },
    };
    const sync = new AssistantProviderSynchronization({
      assistants,
      connections,
      maintenance,
    });
    runtime.beforeSpawn = () => sync.prepare();
    t.after(async () => {
      await runtime.close();
      await reminders.close();
      store.close();
      await server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    await runtime.start();
    const c = connections.create({
      providerId: "endpoint",
      name: "Scheduled endpoint",
      apiKey: "fixture-original-scheduled",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: `${server.origin}/v1`,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [
          {
            modelId: "schedule-fixture",
            source: "manual",
            contextTokens: 32768,
            outputTokens: 4096,
          },
        ],
      },
    });
    const a = store.createAssistant({
      name: "Scheduled",
      instructions: "Reply briefly.",
      model: { connectionId: c.id, modelId: "schedule-fixture" },
      capabilities: { memory: false, reminders: true },
    });
    await config.apply(a.id);
    const snapshot = await runtime.client.call("config.get", {});
    await runtime.client.call("config.patch", {
      baseHash: snapshot.hash,
      raw: JSON.stringify({ cron: { enabled: true } }),
    });
    const { binding } = reminders.bindings.reserve(
      a.id,
      "scheduled",
      { channelId: "fixture" },
      {},
    );
    const job = await runtime.client.call("cron.add", {
      name: "Scheduled provider contract",
      declarationKey: `agentpier-reminder:${binding.id}`,
      agentId: a.runtimeAgentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Give a short reply.",
        toolsAllow: [],
        timeoutSeconds: 30,
      },
      delivery: { mode: "none" },
    });
    const jobId = (job.job || job).id;
    reminders.bindings.patch(binding.id, { nativeId: jobId, state: "bound" });
    let runCount = 0;
    async function runScheduled() {
      await runtime.client.call("cron.run", { id: jobId, mode: "force" });
      for (let n = 0; n < 200; n++) {
        const history = await runtime.client.call("cron.runs", { id: jobId, limit: 20 });
        if (history.entries.length > runCount) {
          runCount = history.entries.length;
          return history.entries.at(0);
        }
        await delay(100);
      }
      assert.fail("scheduled native execution did not finish");
    }
    assert.equal((await runScheduled()).status, "ok");
    assert.ok(
      server.requests.some(
        (r) => r.headers.authorization === "Bearer fixture-original-scheduled",
      ),
    );
    const offset = server.requests.length;
    await sync.change(
      c.id,
      () => connections.update(c.id, { apiKey: "fixture-rotated-scheduled" }),
      { confirmed: true },
    );
    assert.equal((await runScheduled()).status, "ok");
    assert.ok(server.requests.slice(offset).length > 0);
    assert.ok(
      server.requests
        .slice(offset)
        .every((r) => r.headers.authorization === "Bearer fixture-rotated-scheduled"),
    );
    await sync.change(c.id, () => connections.remove(c.id), { confirmed: true });
    const native = await runtime.client.call("config.get", {});
    const entries = native.config.agents.entries;
    const entry = Array.isArray(entries)
      ? entries.find((value) => value.id === a.runtimeAgentId)
      : entries[a.runtimeAgentId];
    assert.deepEqual(entry.model, {
      primary: "agentpier-unavailable/blocked",
      fallbacks: [],
    });
    assert.equal((await reminders.jobs(a)).find((j) => j.id === jobId).enabled, false);
    const beforeRevokedRun = server.requests.length;
    assert.equal((await runScheduled()).status, "error");
    assert.equal(
      server.requests.length,
      beforeRevokedRun,
      "revoked cron job never reaches any model endpoint",
    );
  },
);
