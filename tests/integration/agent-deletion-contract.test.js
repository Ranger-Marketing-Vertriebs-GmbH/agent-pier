import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { removeFromGateway } from "../../server/features/assistants/agent-deletion.js";

// AGENTPIER-260 on the pinned runtime: a permanent delete removes the agent from the
// running Gateway with OpenClaw's own agents.delete (agent-deletion.js): its entry and
// its cron jobs go, its files stay for AgentPier to delete (never moved into a trash
// folder), a second call is a no-op, the other agents stay, and it stays gone after a
// restart. A live config.patch that drops the entry is refused (UNAVAILABLE).
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
test(
  "a deleted agent leaves the running Gateway's roster and stays gone",
  { skip: !installed, timeout: contractTimeout(300000) },
  async (t) => {
    const dataDir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "assistant-agent-deletion-"),
    );
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
      }),
    });
    const store = new AssistantStore({ dataDir });
    t.after(async () => {
      try {
        await runtime.close();
        store.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    const connections = new ProviderConnections({ dataDir });
    await runtime.start();
    const config = new AssistantConfig({
      client: runtime.client,
      models: new AssistantModels({ connections }),
      store,
      workspaces: runtime.paths.workspaces,
    });
    const c = connections.create({
      providerId: "endpoint",
      name: "echo",
      endpoint: {
        preset: "custom",
        openaiBaseUrl: "http://127.0.0.1:9/v1",
        authHeader: null,
        protocols: { messages: false, responses: false, chatCompletions: true },
        models: [
          {
            modelId: "echo-model",
            source: "manual",
            contextTokens: 32768,
            outputTokens: 4096,
          },
        ],
      },
    });
    const agents = [];
    for (const name of ["Kept", "Deleted"]) {
      const a = store.createAssistant({
        name,
        instructions: "Reply briefly.",
        model: { connectionId: c.id, modelId: "echo-model" },
      });
      await config.apply(a.id);
      agents.push(a);
    }
    const [kept, deleted] = agents;
    const listed = async () =>
      (await runtime.client.call("agents.list", {})).agents.map((a) => a.id);
    assert.ok((await listed()).includes(deleted.runtimeAgentId));
    const job = await runtime.client.call("cron.add", {
      name: "Deleted agent routine",
      agentId: deleted.runtimeAgentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(Date.now() + 86400000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Fixture only", timeoutSeconds: 10 },
      delivery: { mode: "none" },
    });
    const jobs = async (agentId) =>
      (await runtime.client.call("cron.list", { agentId, includeDisabled: true })).jobs;
    const added = (job.job || job).id;
    assert.ok((await jobs(deleted.runtimeAgentId)).some((j) => j.id === added));
    const state = path.join(runtime.paths.state, "agents", deleted.runtimeAgentId);
    const workspace = path.join(runtime.paths.workspaces, deleted.id);
    assert.ok(fs.existsSync(state));
    await removeFromGateway(runtime.client, deleted.runtimeAgentId);
    // Nothing left to remove: no second agents.delete.
    await removeFromGateway(runtime.client, deleted.runtimeAgentId);
    // Every cron job of the agent goes, OpenClaw's own heartbeat job too.
    assert.deepEqual(await jobs(deleted.runtimeAgentId), []);
    // AgentPier deletes the files itself; OpenClaw moved nothing into a trash folder.
    assert.ok(fs.existsSync(state));
    assert.ok(fs.existsSync(workspace));
    assert.equal(fs.existsSync(path.join(runtime.paths.home, ".Trash")), false);
    const after = await listed();
    assert.equal(after.includes(deleted.runtimeAgentId), false);
    assert.ok(after.includes(kept.runtimeAgentId));
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    const before = runtime.client;
    await runtime.restart();
    while (!(runtime.client !== before && runtime.client?.ready))
      await new Promise((resolve) => setTimeout(resolve, 20));
    const restarted = await listed();
    assert.equal(restarted.includes(deleted.runtimeAgentId), false);
    assert.ok(restarted.includes(kept.runtimeAgentId));
  },
);
