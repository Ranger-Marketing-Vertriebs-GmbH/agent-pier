import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { WebSearchSettings } from "../../server/features/assistants/web-search-settings.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { hasDocumentExtract } from "../../server/features/assistants/openclaw-config/web-tools.js";
import { agentProfileName } from "../../server/features/assistants/openclaw-config/browser-profiles.js";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { BrowserProfileSync } from "../../server/features/assistants/browser-profile-sync.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";

// Provisioned like the compiled contract (docs/assistant-web-tools-qualification.md).
const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
};

function testBrowser() {
  const named = process.env.AGENTPIER_TEST_BROWSER_PATH;
  const browser = named
    ? { available: fs.existsSync(named), name: "Test", executablePath: named }
    : detectBrowser();
  if (process.env.CI && !browser.available)
    throw Error(
      "No Chromium-based browser for the web tools contract: install one or set AGENTPIER_TEST_BROWSER_PATH.",
    );
  // Never a window on the owner's display: every profile stays headless.
  return { ...browser, visible: { available: false } };
}

const fixtureModel = (url) => ({
  baseUrl: url,
  api: "openai-completions",
  apiKey: "fixture-key",
  models: [
    {
      id: "fixture-model",
      name: "Fixture",
      input: ["text", "image"],
      contextWindow: 32768,
      maxTokens: 4096,
    },
  ],
});
const base = { memory: true, reminders: false };

test(
  "switching one agent's browser, search, fetch and PDFs applies live under the team allow list",
  options,
  async (t) => {
    const browser = testBrowser();
    if (!browser.available) return t.skip("no Chromium-based browser installed");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-web-live-"));
    const store = new AssistantStore({ dataDir });
    const ledger = new RequestLedger(store.db);
    const webSearch = new WebSearchSettings({ dataDir });
    const tool = { name: "session_status", arguments: {} };
    const model = await assistantModelServer({ tool });
    const fixture = { connectionId: "fixture", modelId: "fixture-model" };
    // No agent uses a web capability when the Gateway starts.
    const web = store.createAssistant({
      name: "Web",
      instructions: "Use the tool.",
      model: fixture,
      capabilities: base,
    });
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => {
        const selected = await selectedAssistantRuntime({ dataDir: contractDir });
        return {
          ...selected,
          teamPlugin: provisionTeamPlugin({
            paths: runtime.paths,
            runtimeVersion: selected.version,
          }),
        };
      },
    });
    const models = {
      resolve: () => ({
        providerId: "fixture",
        modelRef: "fixture/fixture-model",
        provider: fixtureModel(model.url),
        release() {},
      }),
    };
    // The start's provider preparation compiles the PDF model, as in the app.
    const synchronization = new AssistantProviderSynchronization({
      assistants: { store, models, runtime, config: { reset() {} } },
      pdfModel: () => fixture,
    });
    runtime.beforeSpawn = () => synchronization.prepare();
    const browsers = new AgentBrowsers({ store, runtime });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime, browsers },
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    t.after(async () => {
      try {
        browsers.close();
        await runtime.close();
        await bridge.close();
        await model.close();
        store.close();
        webSearch.db.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "web-tools-live-fixture" },
      profiles: store.listAssistants(),
      webTools: {
        search: webSearch.resolve(),
        browser,
        searchPlugins: descriptor.searchPlugins || {},
        pdf: { ready: true, ...fixture },
        documentExtract: hasDocumentExtract(descriptor),
      },
    });
    await runtime.start();
    for (let n = 0; n < 120 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 250));
    assert.equal(bridge.guardLive(), true);
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      client: runtime.client,
      teamReady: () => bridge.status().ready,
      hostCapacity: () => 4,
      models,
    });
    config.nativeReady = () => true;
    config.writeGuard = () => bridge.guardLive();
    config.webToolsAvailable = () => runtime.webTools.availability;
    config.browserProfiles = new BrowserProfileSync({
      runtime,
      store,
      stop: (name) => browsers.stop(name),
    });
    await config.apply(web.id);

    const pid = runtime.child.pid;
    const own = agentProfileName(web.id);
    const { config: started } = await runtime.client.call("config.get", {});
    // Compiled although nobody uses them yet: the browser block, the search plugin
    // and PDF extraction, without the agent's own profile.
    assert.equal(started.browser.enabled, true);
    assert.equal(started.browser.profiles[own], undefined);
    for (const id of ["duckduckgo", "document-extract", "browser"])
      assert.ok(started.plugins.allow.includes(id), id);
    for (const name of ["web_search", "web_fetch", "pdf", "browser"])
      assert.ok(started.tools.allow.includes(name), name);
    const before = started.agents.entries[web.runtimeAgentId].tools.allow;
    for (const name of ["web_search", "web_fetch", "pdf", "browser"])
      assert.ok(!before.includes(name), `not yet ${name}`);

    // The owner switches everything on for this one agent.
    const on = store.updateAssistant(
      web.id,
      {
        capabilities: {
          ...base,
          webSearch: true,
          webFetch: true,
          browser: true,
          readPdfs: true,
        },
      },
      web.revision,
    );
    await config.apply(on.id);
    const { config: live } = await runtime.client.call("config.get", {});
    assert.equal(live.browser.profiles[own]?.driver, "openclaw");
    const granted = live.agents.entries[web.runtimeAgentId].tools.allow;
    for (const name of ["web_search", "web_fetch", "pdf", "browser"])
      assert.ok(granted.includes(name), `granted ${name}`);

    async function turn(call, label) {
      Object.assign(tool, call);
      const from = model.requests.length;
      const session = await createGatewaySession(runtime.client, {
        agentId: web.runtimeAgentId,
        label,
      });
      const sent = await runtime.client.call("sessions.send", {
        key: session.key,
        message: "Use the tool.",
        idempotencyKey: label,
      });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      assert.equal(done.status, "ok", label);
      const requests = model.requests.slice(from);
      const result = requests
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(-1);
      // A tool error in full: its own text follows OpenClaw's untrusted-content preamble.
      const shown = result?.includes('"status": "error"')
        ? result
        : result?.slice(0, 300);
      t.diagnostic(`${label} result=${JSON.stringify(shown)}`);
      return { offered: requests[0]?.tools?.map((d) => d.function.name) ?? [], result };
    }
    try {
      const started = await turn(
        { name: "browser", arguments: { action: "start" } },
        "live-start",
      );
      for (const name of ["web_search", "web_fetch", "pdf", "browser"])
        assert.ok(started.offered.includes(name), `offered ${name}`);
      // The start request has a 15 s budget that a cold Chrome launch exceeds on the
      // Intel macOS runner (about 10 s on Apple silicon); OpenClaw then answers
      // "timed out … Retry the browser tool once" while Chrome keeps starting. The
      // agent retries, and so does the contract, once.
      if (/"status": "error"[\s\S]*timed out\./.test(started.result ?? ""))
        await turn(
          { name: "browser", arguments: { action: "start" } },
          "live-start-retry",
        );
      const { result } = await turn(
        { name: "browser", arguments: { action: "status" } },
        "live-status",
      );
      const status = JSON.parse(result);
      assert.equal(status.running, true);
      assert.equal(status.profile, own);
    } finally {
      await browsers.stop(own);
    }
    // Off again: the profile and the grants go, still live.
    const off = store.updateAssistant(
      web.id,
      {
        capabilities: {
          ...base,
          webSearch: false,
          webFetch: false,
          browser: false,
          readPdfs: false,
        },
      },
      on.revision,
    );
    await config.apply(off.id);
    const { config: after } = await runtime.client.call("config.get", {});
    assert.equal(after.browser.profiles[own], undefined);
    assert.ok(!after.agents.entries[web.runtimeAgentId].tools.allow.includes("browser"));

    // The same Gateway process served every step; it never asked for a restart.
    assert.equal(runtime.child.pid, pid);
    const log = fs.readFileSync(
      path.join(runtime.paths.logs, "gateway-console.log"),
      "utf8",
    );
    assert.doesNotMatch(log, /requires gateway restart|recovery restart/i);
  },
);
