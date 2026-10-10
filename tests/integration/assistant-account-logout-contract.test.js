import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { locateOpenClawExports } from "../helpers/openclaw-dist-exports.js";

const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "native account logout pauses scheduled work and preserves the explicit missing identity after restart",
  { skip: !installed, timeout: 240000 },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-logout-contract-"));
    const nodePath = path.join(installed, "node/bin/node");
    const app = path.join(installed, "app/node_modules/openclaw");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).version,
      runtimeManifest.version,
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath,
        entryPath: path.join(app, "openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    const accounts = new AssistantModelAccounts({ dataDir, runtime });
    const models = new AssistantModels({ accounts, connections: { list: () => [] } });
    const config = new AssistantConfig({
      client: { call: (...args) => runtime.client.call(...args) },
      models,
      store,
      workspaces: runtime.paths.workspaces,
    });
    const assistants = new AssistantService({ store, models, config, runtime, accounts });
    const channels = {
      pause: async () => {},
      resume() {},
      store: { list: () => [] },
      outbox: { all: () => [] },
    };
    const reminders = new NativeReminders({ assistants, channels, dataDir });
    assistants.reminders = reminders;
    const services = {
      assistants,
      assistantRuntime: runtime,
      assistantChannels: channels,
      assistantReminders: reminders,
    };
    const maintenance = new AssistantMaintenance(services);
    const sync = new AssistantProviderSynchronization({ assistants, maintenance });
    assistants.providerSynchronization = sync;
    services.assistantProviderSynchronization = sync;
    runtime.beforeSpawn = () => sync.prepare();
    runtime.maintenance = () => assistants.maintenance;
    t.after(async () => {
      await reminders.close();
      await assistants.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    await runtime.start();
    await runtime.stop();
    // Version-pinned native writer, synthetic credentials, isolated HOME/state.
    // Never imports installed credentials and never sends an inference request.
    const writer = locateOpenClawExports(app, ["upsertAuthProfile"]).upsertAuthProfile;
    const code = `import {${writer.alias} as upsert} from ${JSON.stringify(writer.path)};
      for (const id of ['a', 'b']) upsert({
        profileId: 'openai:logout-' + id,
        credential: {type:'oauth', provider:'openai',
          access:'SYNTHETIC_ACCESS_' + id, refresh:'SYNTHETIC_REFRESH_' + id,
          expires:Date.now()+86400000, email:'synthetic-' + id + '@example.invalid'}
      });`;
    execFileSync(nodePath, ["--input-type=module", "-e", code], {
      env: runtimeEnvironment(runtime.paths, nodePath, "fixture"),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    await runtime.start();
    await accounts.list();
    const accountId = `openclaw:${createHash("sha256").update("openai:logout-a").digest("hex")}`;
    const a = store.createAssistant({
      name: "Selected native account",
      model: { connectionId: accountId, modelId: "gpt-5.4" },
      capabilities: { memory: false, reminders: true },
    });
    await config.apply(a.id);
    const { binding } = reminders.bindings.reserve(
      a.id,
      "selected-account-job",
      { channelId: "fixture" },
      {},
    );
    const job = await runtime.client.call("cron.add", {
      name: "Selected account reminder",
      declarationKey: `agentpier-reminder:${binding.id}`,
      agentId: a.runtimeAgentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(Date.now() + 86400000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Fixture only", timeoutSeconds: 10 },
      delivery: { mode: "none" },
    });
    const jobId = (job.job || job).id;
    reminders.bindings.patch(binding.id, { nativeId: jobId, state: "bound" });
    await maintenance.setCron(true);
    const call = runtime.client.call.bind(runtime.client);
    let cronEnabledAtLogout;
    runtime.client.call = async (method, ...args) => {
      if (method === "models.authLogout")
        cronEnabledAtLogout = (await call("cron.status", {})).enabled;
      return call(method, ...args);
    };
    await assistants.logoutAccount(accounts, accountId);
    const checkPin = async () => {
      const native = await runtime.client.call("config.get", {});
      const entries = native.config.agents.entries || native.config.agents.list;
      const entry = Array.isArray(entries)
        ? entries.find((value) => value.id === a.runtimeAgentId)
        : entries[a.runtimeAgentId];
      assert.deepEqual(entry.model, {
        primary: "openai/gpt-5.4@openai:logout-a",
        fallbacks: [],
      });
    };
    await checkPin();
    assert.equal(cronEnabledAtLogout, false);
    assert.equal(
      (await reminders.jobs(a)).find((value) => value.id === jobId).enabled,
      false,
    );
    assert.equal((await accounts.list()).length, 1, "unrelated OAuth account remains");
    await assert.rejects(models.resolve(a.model), { status: 400 });
    await runtime.stop();
    // Simulate reopening account metadata rather than relying on in-memory pins.
    assistants.accounts = models.accounts = new AssistantModelAccounts({
      dataDir,
      runtime,
    });
    await runtime.start();
    await checkPin();
    assert.equal(
      (await reminders.jobs(a)).find((value) => value.id === jobId).enabled,
      false,
    );
  },
);
