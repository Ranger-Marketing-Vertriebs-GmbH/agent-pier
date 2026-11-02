import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBrowser } from "../helpers/browser-start.js";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtimes/openclaw/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { agentProfileName } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/browser-profiles.js";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";

// OpenClaw 2026.10 engages Code Mode while `tools.codeMode` is absent ("auto") for a
// model whose catalog entry prefers it, as ChatGPT's do. A tool called from a Code Mode
// cell returns only its `details`, and the browser's snapshot puts the page into its
// text content: an agent saw the snapshot's statistics but never the page. With Code
// Mode compiled off, such a model is offered the browser itself, and its snapshot
// result carries the page text. Provisioned like the web tools contracts.
const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(240000),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const label = "AGENTPIER_SNAPSHOT_BUTTON";
const text = "AGENTPIER_SNAPSHOT_TEXT";

function testBrowser() {
  const named = process.env.AGENTPIER_TEST_BROWSER_PATH;
  const browser = named
    ? { available: fs.existsSync(named), name: "Test", executablePath: named }
    : detectBrowser();
  if (process.env.CI && !browser.available)
    throw Error(
      "No Chromium-based browser for the browser snapshot contract: install one or set AGENTPIER_TEST_BROWSER_PATH.",
    );
  // Never a window on the owner's display.
  return { ...browser, visible: { available: false } };
}

// The agent's page over CDP, outside OpenClaw: a blank page the test fills (OpenClaw's
// navigation policy keeps local test servers closed).
async function pageTarget(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((x) => x.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiting = pending.get(msg.id);
    if (!waiting) return;
    pending.delete(msg.id);
    msg.error ? waiting.reject(Error(msg.error.message)) : waiting.resolve(msg.result);
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.navigate", { url: "about:blank" });
  const evaluate = async (expression) =>
    (
      await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result.value;
  for (let n = 0; n < 40 && (await evaluate("document.readyState")) !== "complete"; n++)
    await sleep(250);
  const filled = `document.body.innerHTML = '<h1>Studio</h1><p>${text}</p>' +
    '<button>${label}</button>'; document.querySelectorAll("button").length`;
  assert.equal(await evaluate(filled), 1);
  return { id: target.id, close: () => ws.close() };
}

test(
  "a Code Mode preferred model gets the browser and the snapshot's page text",
  options,
  async (t) => {
    const browser = testBrowser();
    if (!browser.available) return t.skip("no Chromium-based browser installed");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-snapshot-"));
    const store = new AssistantStore({ dataDir });
    const ledger = new RequestLedger(store.db);
    const tool = { name: "session_status", arguments: {} };
    const model = await assistantModelServer({ tool });
    const agent = store.createAssistant({
      name: "Snapshot",
      instructions: "Use the tool.",
      model: { connectionId: "fixture", modelId: "fixture-model" },
      capabilities: { memory: false, reminders: false, browser: true },
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
        provider: {
          baseUrl: model.url,
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [
            {
              id: "fixture-model",
              name: "Fixture",
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 4096,
              // The catalog flag that engages Code Mode under OpenClaw's "auto".
              compat: { codeMode: "preferred" },
            },
          ],
        },
        release() {},
      }),
    };
    const browsers = new AgentBrowsers({ store, runtime });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime, browsers },
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    const own = agentProfileName(agent.id);
    let page = null;
    t.after(async () => {
      try {
        page?.close();
        await browsers.stop(own).catch(() => {});
        browsers.close();
        await runtime.close();
        await bridge.close();
        await model.close();
        store.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "browser-snapshot-fixture" },
      profiles: store.listAssistants(),
      webTools: {
        search: { provider: null },
        browser,
        searchPlugins: descriptor.searchPlugins || {},
        pdf: { ready: false },
        documentExtract: false,
      },
    });
    await runtime.start();
    for (let n = 0; n < 120 && !bridge.guardLive(); n++) await sleep(250);
    assert.equal(bridge.guardLive(), true);
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      runtime,
      teamReady: () => bridge.status().ready,
      hostCapacity: () => 4,
      models,
    });
    config.nativeReady = () => true;
    config.writeGuard = () => bridge.guardLive();
    config.webToolsAvailable = () => runtime.webTools.availability;
    await config.apply(agent.id);

    // The Gateway runs the compiled switch, and the model keeps its catalog flag.
    const { config: running } = await runtime.client.call("config.get", {});
    assert.equal(running.tools.codeMode, false);
    assert.equal(running.agents.entries[agent.runtimeAgentId].tools.codeMode, undefined);
    assert.equal(
      running.models.providers.fixture.models[0].compat?.codeMode,
      "preferred",
    );

    async function turn(call, name) {
      Object.assign(tool, call);
      const from = model.requests.length;
      const session = await createGatewaySession(runtime.client, {
        agentId: agent.runtimeAgentId,
        label: name,
      });
      const sent = await runtime.client.call("sessions.send", {
        key: session.key,
        message: "Use the tool.",
        idempotencyKey: name,
      });
      const done = await runtime.client.call(
        "agent.wait",
        { runId: sent.runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      assert.equal(done.status, "ok", name);
      const requests = model.requests.slice(from);
      const result = requests
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(-1);
      t.diagnostic(`${name} result=${JSON.stringify(result?.slice(0, 400))}`);
      return { offered: requests[0]?.tools?.map((d) => d.function.name) ?? [], result };
    }

    try {
      // Retried once after a timed-out start (helpers/browser-start.js).
      const { offered, result: started } = await startBrowser((name) =>
        turn({ name: "browser", arguments: { action: "start" } }, `snapshot-${name}`),
      );
      t.diagnostic(`offered=${JSON.stringify(offered)}`);
      // Code Mode would offer only its `exec` cell and `wait`.
      assert.ok(offered.includes("browser"), JSON.stringify(offered));
      assert.ok(!offered.includes("exec") && !offered.includes("wait"));
      const { result: status } = await turn(
        { name: "browser", arguments: { action: "status" } },
        "snapshot-status",
      );
      assert.equal(JSON.parse(status).running, true, `start=${started} status=${status}`);
      page = await pageTarget(runtime.webTools.browserProfiles[own].cdpPort);
      const { result: snapshot } = await turn(
        { name: "browser", arguments: { action: "snapshot", targetId: page.id } },
        "snapshot",
      );
      // The page structure itself, not only the snapshot's statistics.
      assert.match(snapshot, new RegExp(`button "${label}"`));
      assert.match(snapshot, new RegExp(text));
    } finally {
      await browsers.stop(own);
    }
  },
);
