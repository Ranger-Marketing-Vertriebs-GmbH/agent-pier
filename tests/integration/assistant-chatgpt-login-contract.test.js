import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";

// The installation provisioned by scripts/provision-assistant-contracts.mjs. The
// Gateway runs AgentPier's own team-mode compile, whose plugins.allow is restrictive.
const installed = process.env.AGENTPIER_TEAM_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_TEAM_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(240000),
};

test(
  "the team-mode Gateway starts the ChatGPT device-code sign-in",
  options,
  async (t) => {
    assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-chatgpt-login-"));
    const store = new AssistantStore({ dataDir });
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => {
        const selected = await selectedAssistantRuntime({ dataDir: contractDir });
        assert.ok(path.resolve(selected.nodePath).startsWith(installed + path.sep));
        return {
          ...selected,
          teamPlugin: provisionTeamPlugin({
            paths: runtime.paths,
            runtimeVersion: selected.version,
          }),
        };
      },
    });
    const models = { resolve: () => assert.fail("no model"), listCapabilities: () => [] };
    const config = new AssistantConfig({
      store,
      models,
      workspaces: runtime.paths.workspaces,
      client: { call: (...args) => runtime.client.call(...args) },
      hostCapacity: () => 4,
    });
    const assistants = new AssistantService({ store, runtime, config, models });
    const teams = (assistants.teams = new TeamService({ assistants, autoStart: false }));
    const bridge = (teams.bridge = new TeamBridge({
      assistants,
      teams,
      generation: () => runtime.generation,
    }));
    Object.assign(config, {
      teamReady: () => bridge.status().ready,
      writeGuard: () => false,
      nativeReady: () => true,
      webToolsAvailable: () => ({}),
      mcpTools: () => [],
    });
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "chatgpt-login-fixture" },
      profiles: store.listAssistants(),
      webTools: { search: {}, browser: { available: false }, searchPlugins: {} },
    });
    t.after(async () => {
      try {
        await assistants.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    await runtime.start();
    const client = runtime.client;
    const { config: running } = await client.call("config.get", {});
    t.diagnostic(`plugins.allow=${JSON.stringify(running.plugins.allow)}`);
    assert.ok(running.plugins.allow.includes("agentpier-teams"), "team mode");

    // The exact call AssistantAccountLogin makes. Before the fix the Gateway answered
    // INVALID_REQUEST "That provider login is no longer available".
    const sessionId = "chatgpt-login-contract";
    const started = await client.call(
      "models.authLogin",
      { sessionId, agentId: "main", authChoice: "openai/openai-device-code" },
      { timeoutMs: 60000 },
    );
    try {
      t.diagnostic(`models.authLogin=${JSON.stringify(started)}`);
      assert.equal(started.done, false);
      // The first step is the wizard's own progress step; the device code follows
      // only after a request to OpenAI, which this contract never waits for.
      const first = await client.call("wizard.next", { sessionId }, { timeoutMs: 30000 });
      t.diagnostic(`first step type=${first.step?.type} done=${first.done}`);
      assert.equal(first.done, false);
      assert.equal(first.step?.type, "progress");
      assert.equal(first.step?.sensitive, undefined);
    } finally {
      await client
        .call("wizard.cancel", { sessionId, closeInput: true }, { timeoutMs: 5000 })
        .catch(() => {});
    }
  },
);
