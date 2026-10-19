import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
import { capabilityTools } from "../../server/features/assistants/native-capabilities.js";
import { defaultGrants } from "../../server/features/assistants/member-grants.js";
import {
  hasDocumentExtract,
  webToolsSections,
} from "../../server/features/assistants/openclaw-config/web-tools.js";
import { AgentBrowsers } from "../../server/features/assistants/agent-browsers.js";
import { BrowserLiveView } from "../../server/features/assistants/browser-live-view.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { textPdf } from "../helpers/text-pdf.js";

// The installation provisioned by scripts/provision-assistant-contracts.mjs: its data
// directory yields the runtime descriptor, including the bundled search plugins.
const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: 300000,
};

// AgentPier's own detection, unless the environment names the browser to drive.
function testBrowser() {
  const named = process.env.AGENTPIER_TEST_BROWSER_PATH;
  const browser = named
    ? { available: fs.existsSync(named), name: "Test", executablePath: named }
    : detectBrowser();
  // CI must exercise the browser; a missing one is a runner problem, not a skip.
  if (process.env.CI && !browser.available)
    throw Error(
      "No Chromium-based browser for the web tools contract: install one or set AGENTPIER_TEST_BROWSER_PATH.",
    );
  return browser;
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

const everything = {
  memory: true,
  reminders: true,
  webSearch: true,
  webFetch: true,
  browser: true,
  documents: true,
  readPdfs: true,
};

test(
  "the Gateway runs the compiled web tools, browser and search provider in team mode",
  options,
  async (t) => {
    assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
    const browser = testBrowser();
    t.diagnostic(`browser=${JSON.stringify(browser)}`);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-web-compiled-"));
    const store = new AssistantStore({ dataDir });
    const ledger = new RequestLedger(store.db);
    const webSearch = new WebSearchSettings({ dataDir });
    const tool = { name: "session_status", arguments: {} };
    const model = await assistantModelServer({ tool });
    const page = http.createServer((req, res) => {
      page.hits++;
      res.setHeader("content-type", "text/html");
      res.end("<html><body><p>AGENTPIER_WEB_MARKER</p></body></html>");
    });
    page.hits = 0;
    await new Promise((r) => page.listen(0, "127.0.0.1", r));
    const local = `http://127.0.0.1:${page.address().port}/`;

    const fixture = { connectionId: "fixture", modelId: "fixture-model" };
    const web = store.createAssistant({
      name: "Web",
      instructions: "Use the tool.",
      model: fixture,
      capabilities: everything,
    });
    // A temporary team member runs with what its lead granted within the lead's own
    // capabilities, never with its own: `member` has the default grants (memory, web
    // search, web pages) under Web, `isolated` has everything recorded under a lead
    // without any.
    const plain = store.createAssistant({
      name: "Plain",
      instructions: "Use the tool.",
      model: fixture,
    });
    const reserve = (id, parent) =>
      store.reserveMember({
        id,
        parent,
        assignment: { name: "Member", role: "Review", assignment: "Review" },
        snapshot: { instructions: "Use the tool.", model: fixture },
        teamId: `team-${id}`,
        lifetime: "temporary",
      });
    // TeamStore answers this in the app: the default grants for `member` only.
    store.memberGrants = (m) => ({
      grants: m.id === "member-1" ? defaultGrants : {},
      shellSsh: false,
    });
    const member = store.getAssistant(reserve("member-1", web.id).id);
    const reserved = reserve("member-2", plain.id);
    store.db
      .prepare("UPDATE assistants SET body=? WHERE id=?")
      .run(JSON.stringify({ ...reserved, capabilities: everything }), reserved.id);
    const isolated = store.getAssistant(reserved.id);

    let selected;
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => {
        // The real descriptor of the provisioned runtime, with its team plugin
        // provisioned into this test's own data directory.
        selected = await selectedAssistantRuntime({ dataDir: contractDir });
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
    const models = {
      resolve: () => ({
        providerId: "fixture",
        modelRef: "fixture/fixture-model",
        provider: fixtureModel(model.url),
        release() {},
      }),
    };
    // The owner chose the fixture model for PDFs; the real provider preparation
    // compiles it into agents.defaults.pdfModel before each spawn, as in the app.
    const pdfModel = { connectionId: "fixture", modelId: "fixture-model" };
    const synchronization = new AssistantProviderSynchronization({
      assistants: { store, models, runtime, config: { reset() {} } },
      pdfModel: () => pdfModel,
    });
    runtime.beforeSpawn = async () => {
      await synchronization.prepare();
      // Linux only, opt-in: a runner whose kernel refuses Chrome's sandbox. This
      // touches the test's startup file, never AgentPier's compiled configuration.
      if (process.env.AGENTPIER_TEST_BROWSER_NO_SANDBOX !== "1") return;
      const config = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8"));
      if (config.browser.enabled) config.browser.noSandbox = true;
      fs.writeFileSync(runtime.paths.config, JSON.stringify(config));
    };
    // The tool guard pins every browser call to the agent's own profile.
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
        await new Promise((r) => {
          page.closeAllConnections();
          page.close(r);
        });
        store.close();
        webSearch.db.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    let compiledInputs, teamDirectory;
    runtime.teamConfiguration = async (descriptor) => {
      teamDirectory = descriptor.teamPlugin.directory;
      compiledInputs = {
        profiles: store.listAssistants(),
        webTools: {
          search: webSearch.resolve(),
          browser,
          searchPlugins: descriptor.searchPlugins || {},
          pdf: { ready: true, ...pdfModel },
          documentExtract: hasDocumentExtract(descriptor),
        },
      };
      return {
        directory: descriptor.teamPlugin.directory,
        connection: await bridge.start(),
        hostMaxConcurrent: 4,
        native: { token: "web-tools-fixture" },
        ...compiledInputs,
      };
    };
    await runtime.start();
    const config = new AssistantConfig({
      store,
      workspaces: runtime.paths.workspaces,
      client: runtime.client,
      teamReady: () => bridge.status().ready,
      hostCapacity: () => 4,
      models,
    });
    config.nativeReady = () => true;
    // The browser waits for the plugin's proven tool guard, like guarded writes.
    config.writeGuard = () => bridge.guardLive();
    config.webToolsAvailable = () => runtime.webTools.availability;
    await config.apply(web.id);
    await config.apply(member.id);
    await config.apply(isolated.id);
    // Restart: the per-agent entries now come from the startup compile as well.
    await runtime.restart();
    config.client = runtime.client;
    assert.equal(runtime.status().availability, "ready");
    // The start compiled the browser out; the guard's report brings it back.
    for (let n = 0; n < 120 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 250));
    assert.equal(bridge.guardLive(), true);
    // A restarted Gateway is applied afresh, as AgentPier does at each start.
    config.reset();
    await config.apply(web.id);

    // The bundled DuckDuckGo plugin is the default provider and comes from the
    // runtime descriptor.
    const ddg = selected.searchPlugins.duckduckgo;
    assert.equal(ddg.id, "duckduckgo");
    assert.ok(ddg.directory.startsWith(installed + path.sep), ddg.directory);
    // Every capability reports its availability; no ChatGPT account signs in here.
    assert.deepEqual(runtime.webTools.availability, {
      createImages: false,
      readPdfs: true,
      browser: browser.available,
      webSearch: true,
    });

    // The Gateway accepted the compiled configuration: team plugin, memory, the
    // search plugin and the browser under one restrictive allow list.
    const { config: running } = await runtime.client.call("config.get", {});
    const sections = webToolsSections({
      ...compiledInputs,
      port: running.gateway.port,
    });
    assert.deepEqual(running.plugins.allow, [
      "agentpier-teams",
      "openai",
      "memory-core",
      "duckduckgo",
      "document-extract",
      ...(browser.available ? ["browser"] : []),
    ]);
    assert.deepEqual(running.plugins.load.paths, [teamDirectory, ddg.directory]);
    assert.equal(
      running.plugins.entries.duckduckgo?.config?.webSearch?.apiKey,
      undefined,
      "no key for DuckDuckGo",
    );
    assert.deepEqual(running.tools.web, {
      search: { provider: "duckduckgo" },
      fetch: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } },
    });
    for (const name of Object.values(capabilityTools).flat())
      if ((name !== "browser" || browser.available) && name !== "image_generate")
        assert.ok(running.tools.allow.includes(name), name);
    // Image creation needs a signed-in ChatGPT account, which no contract has.
    assert.equal(running.tools.allow.includes("image_generate"), false);
    assert.equal(running.agents.defaults.mediaModels, undefined);
    // The one PDF model every agent reads with, from the owner's choice.
    assert.deepEqual(running.agents.defaults.pdfModel, {
      primary: "fixture/fixture-model",
      fallbacks: [],
    });
    assert.deepEqual(running.browser, sections.browser ?? { enabled: false });
    const listed = await runtime.client.call("plugins.list", {});
    const plugins = listed.plugins ?? listed;
    for (const id of running.plugins.allow) {
      const plugin = plugins.find((p) => p.id === id);
      t.diagnostic(`plugin ${id}=${JSON.stringify(plugin?.runtime)}`);
      assert.equal(plugin?.enabled ?? true, true, id);
      assert.notEqual(plugin?.runtime?.state, "error", id);
    }
    const entry = (agent) => running.agents.entries[agent.runtimeAgentId];
    const granted = entry(web).tools.allow;
    t.diagnostic(`web agent allow=${JSON.stringify(granted)}`);
    for (const name of ["web_search", "web_fetch", "view_image", "pdf"])
      assert.ok(granted.includes(name), name);
    assert.equal(granted.includes("browser"), browser.available);
    const inherited = entry(member).tools.allow;
    t.diagnostic(`member allow=${JSON.stringify(inherited)}`);
    for (const name of ["web_search", "web_fetch", "memory_search"])
      assert.ok(inherited.includes(name), `member ${name}`);
    // Not granted by default; team tools, routines, memory writes and shell stay
    // with the lead.
    for (const name of [
      "browser",
      "view_image",
      "pdf",
      "agentpier_reminder",
      "agentpier_team_propose",
      "agentpier_routine",
      "write",
      "exec",
    ])
      assert.ok(!inherited.includes(name), `member ${name}`);
    const withheld = entry(isolated).tools.allow;
    t.diagnostic(`isolated allow=${JSON.stringify(withheld)}`);
    for (const name of Object.values(capabilityTools).flat())
      assert.ok(!withheld.includes(name), `isolated ${name}`);

    // One turn of `agent` on the deterministic model; returns what it was offered
    // and the tool result OpenClaw sent back.
    async function turn(agent, call, label) {
      Object.assign(tool, call);
      const from = model.requests.length;
      const session = await runtime.client.call("sessions.create", {
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
      const requests = model.requests.slice(from);
      const result = requests
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(-1);
      t.diagnostic(`${label} result=${JSON.stringify(result?.slice(0, 400))}`);
      return { offered: requests[0]?.tools?.map((d) => d.function.name) ?? [], result };
    }

    // web_search is offered with DuckDuckGo; it is not called (no real search).
    // web_fetch refuses a loopback target before any request leaves the Gateway.
    const fetched = await turn(
      web,
      { name: "web_fetch", arguments: { url: local } },
      "web-fetch",
    );
    t.diagnostic(`web agent offered=${JSON.stringify(fetched.offered)}`);
    for (const name of ["web_search", "web_fetch", "view_image", "pdf"])
      assert.ok(fetched.offered.includes(name), `offered ${name}`);
    assert.equal(fetched.offered.includes("browser"), browser.available);
    assert.match(fetched.result, /Blocked hostname or private\/internal\/special-use IP/);
    assert.equal(page.hits, 0);

    // Read PDFs: a workspace PDF reaches the owner's PDF model as extracted text.
    fs.writeFileSync(
      path.join(runtime.paths.workspaces, web.id, "report.pdf"),
      textPdf("AGENTPIER_PDF_MARKER quarterly report"),
    );
    const from = model.requests.length;
    const read = await turn(
      web,
      { name: "pdf", arguments: { pdf: "report.pdf", prompt: "Summarize it." } },
      "pdf-read",
    );
    const pdfRequests = model.requests
      .slice(from)
      .filter((r) => JSON.stringify(r.messages).includes("AGENTPIER_PDF_MARKER"));
    assert.ok(pdfRequests.length, "the PDF text reached the PDF model");
    assert.equal(pdfRequests[0].model, "fixture-model");
    assert.match(read.result, /A useful assistant reply/);
    // The tool guard keeps calls on workspace files and the owner's PDF model.
    const remote = await turn(
      web,
      { name: "pdf", arguments: { pdf: local } },
      "pdf-remote",
    );
    assert.match(remote.result, /without a web address/);
    assert.equal(page.hits, 0);
    const other = await turn(
      web,
      { name: "pdf", arguments: { pdf: "report.pdf", model: "fixture/other" } },
      "pdf-model",
    );
    assert.match(other.result, /Leave model unset/);

    // The lead's member is offered its granted web tools under the same private
    // network block.
    const followed = await turn(
      member,
      { name: "web_fetch", arguments: { url: local } },
      "member-fetch",
    );
    t.diagnostic(`member offered=${JSON.stringify(followed.offered)}`);
    assert.ok(followed.offered.includes("web_fetch"));
    assert.match(
      followed.result,
      /Blocked hostname or private\/internal\/special-use IP/,
    );
    assert.equal(page.hits, 0);

    // A member whose lead has none is offered none of the capability tools, and its
    // own web_fetch request cannot run.
    const denied = await turn(
      isolated,
      { name: "web_fetch", arguments: { url: local } },
      "isolated-fetch",
    );
    t.diagnostic(`isolated offered=${JSON.stringify(denied.offered)}`);
    for (const name of Object.values(capabilityTools).flat())
      assert.ok(!denied.offered.includes(name), `isolated offered ${name}`);
    assert.equal(page.hits, 0);

    await t.test(
      "the browser runs only the agent's own profile inside the data dir",
      async (st) => {
        if (!browser.available) return st.skip("no Chromium-based browser installed");
        const call = (args, label) =>
          turn(web, { name: "browser", arguments: args }, label);
        const { result: status } = await call({ action: "status" }, "browser-status");
        const state = JSON.parse(status);
        const own = `agent-${web.id}`;
        assert.equal(state.profile, own);
        assert.equal(state.driver, "openclaw");
        assert.equal(state.executablePath, browser.executablePath);
        const { result: listedProfiles } = await call({ action: "profiles" }, "profiles");
        const { profiles } = JSON.parse(listedProfiles);
        assert.deepEqual(profiles.map((p) => p.name).sort(), [
          own,
          "chrome",
          "member-1",
          "member-2",
          "member-3",
          "openclaw",
          "user",
        ]);
        // The model naming another profile still drives the agent's own.
        const { result: other } = await call(
          { action: "status", profile: "openclaw" },
          "other-profile",
        );
        assert.equal(JSON.parse(other).profile, own);
        for (const profile of profiles)
          assert.equal(profile.driver, "openclaw", profile.name);
        const { result: imported } = await call({ action: "importprofile" }, "import");
        // AgentPier's tool guard refuses it before OpenClaw sees it.
        assert.match(imported, /Importing a system browser profile is not allowed/);
        const { result: blocked } = await call({ action: "open", url: local }, "blocked");
        assert.match(blocked, /browser navigation blocked by policy/);
        assert.equal(page.hits, 0);
        try {
          await call({ action: "start" }, "start");
          const { result: running } = await call({ action: "status" }, "browser-running");
          const { running: launched, userDataDir } = JSON.parse(running);
          assert.equal(launched, true);
          assert.ok(
            fs.realpathSync(userDataDir).startsWith(fs.realpathSync(dataDir) + path.sep),
            userDataDir,
          );
          assert.equal(path.basename(path.dirname(userDataDir)), own);
          // The owner's live view: a screencast ticket on the agent's own profile,
          // opened on the pinned Gateway connection, delivers frames.
          const live = new BrowserLiveView({
            browsers,
            runtime,
            pollMs: 60000,
            retryMs: 500,
          });
          const frames = [],
            states = [];
          const view = live.subscribe(web.id, {
            state: (state) => states.push(state),
            frame: (bytes) => frames.push(Buffer.from(bytes)),
          });
          for (let n = 0; n < 300 && !frames.length; n++)
            await new Promise((r) => setTimeout(r, 50));
          // The owner's takeover: input reaches the tab over the profile's real CDP
          // port, and the agent's browser calls wait meanwhile.
          const owner = live.subscribe(
            web.id,
            { state() {}, frame() {}, end() {} },
            { holder: "contract-owner" },
          );
          owner.take();
          browsers.controlled = (id) => live.controlled(id);
          for (const command of [
            {
              type: "pointer",
              action: "down",
              x: 0.5,
              y: 0.5,
              button: "left",
              buttons: 1,
              clickCount: 1,
            },
            {
              type: "pointer",
              action: "up",
              x: 0.5,
              y: 0.5,
              button: "left",
              buttons: 0,
              clickCount: 1,
            },
            { type: "text", text: "contract" },
            { type: "key", action: "down", key: "Enter", code: "Enter" },
          ])
            await owner.input(command);
          const { result: waiting } = await call(
            { action: "status" },
            "while-controlled",
          );
          assert.match(waiting, /The owner is using this browser right now/);
          assert.equal(owner.handBack(), true);
          browsers.controlled = undefined;
          owner.close();
          view.close();
          live.close();
          st.diagnostic(`live states=${JSON.stringify(states.map((s) => s.status))}`);
          assert.ok(frames.length, "a live frame");
          const headerLength = frames[0].readUInt32BE(0);
          const header = JSON.parse(frames[0].subarray(4, 4 + headerLength).toString());
          assert.equal(typeof header.cssWidth, "number");
          assert.deepEqual(
            [...frames[0].subarray(4 + headerLength, 6 + headerLength)],
            [0xff, 0xd8],
          );
          assert.equal(states.at(-1).status, "live");
        } finally {
          const { result: stopped } = await call({ action: "stop" }, "stop");
          assert.equal(JSON.parse(stopped).running, false);
        }
      },
    );
  },
);
