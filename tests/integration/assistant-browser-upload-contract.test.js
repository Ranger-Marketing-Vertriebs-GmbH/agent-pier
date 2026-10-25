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
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { agentProfileName } from "../../server/features/assistants/openclaw-config/browser-profiles.js";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { BrowserProfileSync } from "../../server/features/assistants/browser-profile-sync.js";
import { AgentBrowserUploads } from "../../server/features/assistants/agent-browser-uploads.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// A real browser upload through the pinned OpenClaw (docs/assistant-gateway.md
// "Browser uploads"), provisioned like the web tools contracts.
const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testBrowser() {
  const named = process.env.AGENTPIER_TEST_BROWSER_PATH;
  const browser = named
    ? { available: fs.existsSync(named), name: "Test", executablePath: named }
    : detectBrowser();
  if (process.env.CI && !browser.available)
    throw Error(
      "No Chromium-based browser for the browser upload contract: install one or set AGENTPIER_TEST_BROWSER_PATH.",
    );
  // Never a window on the owner's display.
  return { ...browser, visible: { available: false } };
}

// The page of the agent's browser over CDP, outside OpenClaw: a blank page that the
// test fills with a file input (OpenClaw's navigation policy keeps local test
// servers closed, also for an upload into their page) and reads back.
const pageScript = `document.body.innerHTML = '<input type=file id=f>';
  f.onchange = async () => {
    const file = f.files[0];
    document.title = "got:" + file.name + ":" + file.size + ":" + (await file.text());
  };
  true`;
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
  assert.equal(await evaluate(pageScript), true);
  return { id: target.id, evaluate, close: () => ws.close() };
}

test(
  "an agent's browser uploads its own staged file and nothing else",
  options,
  async (t) => {
    const browser = testBrowser();
    if (!browser.available) return t.skip("no Chromium-based browser installed");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-upload-"));
    const store = new AssistantStore({ dataDir });
    const ledger = new RequestLedger(store.db);
    const tool = { name: "session_status", arguments: {} };
    const model = await assistantModelServer({ tool });
    const fixture = { connectionId: "fixture", modelId: "fixture-model" };
    const capabilities = { memory: false, reminders: false, browser: true };
    const agent = store.createAssistant({
      name: "Uploader",
      instructions: "Use the tool.",
      model: fixture,
      capabilities,
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
            },
          ],
        },
        release() {},
      }),
    };
    const audits = [];
    const browsers = new AgentBrowsers({ store, runtime });
    // The workflows' staging, on the runtime's real paths and OpenClaw's real
    // uploads folder (its own namespace for this data directory).
    const uploads = new AgentBrowserUploads({
      a: { store, runtime },
      s: { audit: { append: (event) => audits.push(event) } },
      now: Date.now,
    });
    const bridge = new TeamBridge({
      assistants: {
        store,
        ledger,
        runtime,
        browsers,
        workflows: { browserUploads: uploads },
      },
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    t.after(async () => {
      try {
        uploads.close();
        browsers.close();
        await runtime.close();
        await bridge.close();
        await model.close();
        store.close();
      } finally {
        if (uploads.files)
          fs.rmSync(uploads.files.namespace(), { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "browser-upload-fixture" },
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
    await config.apply(agent.id);
    const own = agentProfileName(agent.id);

    // A finished episode in the agent's workspace and one in a project folder.
    const workspace = path.join(runtime.paths.workspaces, agent.id);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "episode.mp4"), "episode-bytes");
    const project = fs.mkdtempSync(path.join(dataDir, "project-"));
    fs.writeFileSync(path.join(project, "trailer.mp4"), "trailer");
    const staged = await uploads.staging.stage(agent.id, {
      root: workspace,
      raw: "episode.mp4",
    });
    const foreign = await uploads.staging.stage("someone-else", {
      root: project,
      raw: "trailer.mp4",
    });

    async function turn(call, label) {
      Object.assign(tool, call);
      const from = model.requests.length;
      const session = await createGatewaySession(runtime.client, {
        agentId: agent.runtimeAgentId,
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
      const result = model.requests
        .slice(from)
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(-1);
      t.diagnostic(`${label} result=${JSON.stringify(result?.slice(0, 400))}`);
      return result ?? "";
    }
    let target = null;
    try {
      await startBrowser((label) =>
        turn({ name: "browser", arguments: { action: "start" } }, `upload-${label}`),
      );
      const port = runtime.webTools.browserProfiles[own].cdpPort;
      target = await pageTarget(port);
      const upload = (paths, label) =>
        turn(
          {
            name: "browser",
            arguments: { action: "upload", paths, element: "#f", targetId: target.id },
          },
          label,
        );
      // Another agent's staged file and the project file itself never reach the page.
      assert.match(
        await upload([foreign.path], "upload-foreign"),
        /browser_upload_stage/,
      );
      assert.match(
        await upload([path.join(project, "trailer.mp4")], "upload-outside"),
        /cannot upload this file from where it is/,
      );
      assert.equal(await target.evaluate("document.title"), "");
      // The agent's own staged file is accepted by OpenClaw and arrives in full.
      await upload([staged.path], "upload-own");
      let title = "";
      for (let n = 0; n < 40 && !title; n++) {
        title = await target.evaluate("document.title");
        if (!title) await sleep(250);
      }
      assert.equal(title, "got:episode.mp4:13:episode-bytes");
      const used = audits.filter((e) => e.details?.browserUpload === "browser");
      assert.equal(used.length, 1);
      assert.equal(used[0].resourceId, agent.id);
      assert.equal(used[0].details.filePath, "episode.mp4");
    } finally {
      target?.close();
      await browsers.stop(own);
    }
  },
);
