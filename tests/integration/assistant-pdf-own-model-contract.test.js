import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { PdfPolicy } from "../../server/features/assistants/pdf-policy.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { hasDocumentExtract } from "../../server/features/assistants/openclaw-config/web-tools.js";
import { AssistantProviderSynchronization } from "../../server/features/assistants/assistant-provider-synchronization.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { textPdf } from "../helpers/text-pdf.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// OpenClaw takes a PDF model only from the global agents.defaults.pdfModel. AgentPier
// compiles it explicitly without fallbacks (the owner's fallback or a placeholder),
// and the tool guard names each call's model (pdf-policy.js). This pins on the
// provisioned runtime that the guard's model is the one that reads, that nothing is
// ever auto-picked from the other configured providers, and that a text-only model
// gets the PDF's text without page images.
const installed = process.env.AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_WEB_TOOLS_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
};
const placeholder = "agentpier-unavailable/blocked";
// Image input per connection; `decoy` is a configured image model nobody reads with.
const images = { vision: true, text: false, decoy: true, fallback: true };

test(
  "pdf reads with the model the tool guard names and never auto-picks",
  options,
  async (t) => {
    assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-pdf-own-"));
    const store = new AssistantStore({ dataDir });
    const ledger = new RequestLedger(store.db);
    // Every connection's model calls `pdf` once in a chat turn (the tool's own request
    // offers no tools and gets a plain reply).
    const call = { name: "pdf", arguments: {} };
    const servers = {};
    for (const id of Object.keys(images))
      servers[id] = await assistantModelServer({ tool: () => call });
    const provider = (id) => ({
      baseUrl: servers[id].url,
      api: "openai-completions",
      apiKey: `${id}-fixture-key`,
      models: [
        {
          id: `${id}-model`,
          name: id,
          input: images[id] ? ["text", "image"] : ["text"],
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ],
    });
    const models = {
      resolve: ({ connectionId }) => ({
        providerId: `ap-${connectionId}`,
        modelRef: `ap-${connectionId}/${connectionId}-model`,
        provider: provider(connectionId),
        release() {},
      }),
      imageInput: ({ connectionId }) => images[connectionId],
    };
    const agent = (id, readPdfs = true) =>
      store.createAssistant({
        name: id,
        instructions: "Use the tool.",
        model: { connectionId: id, modelId: `${id}-model` },
        capabilities: { memory: false, reminders: false, readPdfs },
      });
    const vision = agent("vision");
    const text = agent("text");
    // Its provider is configured with an image model and a key: what auto-pick takes.
    const decoy = agent("decoy", false);

    let fallback = null;
    let selected;
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => {
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
    const synchronization = new AssistantProviderSynchronization({
      assistants: { store, models, runtime, config: { reset() {} } },
      pdfModel: () => fallback,
    });
    runtime.beforeSpawn = () => synchronization.prepare();
    const policy = new PdfPolicy({
      assistants: { store, models, providerSynchronization: synchronization },
    });
    const bridge = new TeamBridge({
      assistants: { store, ledger, runtime, pdfPolicy: policy },
      generation: () => runtime.generation,
      teams: { store: { context: () => ({ kind: "owner" }) } },
    });
    t.after(async () => {
      try {
        await runtime.close();
        await bridge.close();
        for (const server of Object.values(servers)) await server.close();
        store.close();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    runtime.teamConfiguration = async (descriptor) => ({
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "pdf-own-fixture" },
      profiles: store.listAssistants(),
      webTools: {
        search: { provider: "duckduckgo", unavailable: true },
        browser: { available: false },
        searchPlugins: {},
        pdf: fallback ? { ready: true, ...fallback } : { ready: false },
        documentExtract: hasDocumentExtract(descriptor),
      },
    });
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
    const agents = [vision, text, decoy];
    // A start whose entries exist, with the proven guard that offers pdf.
    async function start(first) {
      if (first) {
        await runtime.start();
        config.client = runtime.client;
        for (const profile of agents) await config.apply(profile.id);
      }
      await runtime.restart();
      config.client = runtime.client;
      for (let n = 0; n < 120 && !bridge.guardLive(); n++)
        await new Promise((r) => setTimeout(r, 250));
      assert.equal(bridge.guardLive(), true);
      config.reset();
      for (const profile of agents) await config.apply(profile.id);
      const { config: running } = await runtime.client.call("config.get", {});
      return running;
    }
    const marker = (request) =>
      JSON.stringify(request.messages).includes("AGENTPIER_PDF");
    const pageImages = (request) =>
      request.messages.some(
        (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"),
      );
    // One turn of `profile` calling pdf with `args`: which servers the PDF reached, and
    // the tool result its own model got back.
    async function read(profile, args, label) {
      Object.assign(call, { arguments: { pdf: "report.pdf", ...args } });
      const from = Object.fromEntries(
        Object.entries(servers).map(([id, s]) => [id, s.requests.length]),
      );
      fs.writeFileSync(
        path.join(runtime.paths.workspaces, profile.id, "report.pdf"),
        textPdf("AGENTPIER_PDF quarterly report"),
      );
      const session = await createGatewaySession(runtime.client, {
        agentId: profile.runtimeAgentId,
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
      const reached = Object.fromEntries(
        Object.entries(servers).map(([id, s]) => [
          id,
          s.requests.slice(from[id]).filter(marker),
        ]),
      );
      const result = servers[profile.model.connectionId].requests
        .slice(from[profile.model.connectionId])
        .flatMap((r) => r.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content))
        .at(-1);
      t.diagnostic(`${label} result=${JSON.stringify(result?.slice(0, 300))}`);
      return { reached, result };
    }
    const only = (reached, id) =>
      assert.deepEqual(
        Object.keys(reached).filter((key) => reached[key].length),
        id ? [id] : [],
      );

    // Without a fallback the start compiles the placeholder, explicit and alone.
    let running = await start(true);
    assert.deepEqual(running.agents.defaults.pdfModel, {
      primary: placeholder,
      fallbacks: [],
    });
    assert.ok(
      running.models.providers["ap-decoy"],
      "the decoy's image model is configured",
    );
    for (const profile of [vision, text])
      assert.ok(
        running.agents.entries[profile.runtimeAgentId].tools.allow.includes("pdf"),
      );

    // An agent whose model takes images reads with it, page images included; the model
    // it names itself is replaced.
    const own = await read(vision, { model: "ap-decoy/decoy-model" }, "vision-own");
    only(own.reached, "vision");
    assert.equal(own.reached.vision[0].model, "vision-model");
    assert.equal(pageImages(own.reached.vision[0]), true);
    assert.match(own.result, /A useful assistant reply/);

    // A text-only agent without a fallback reads with its own model: text only.
    const plain = await read(text, {}, "text-own");
    only(plain.reached, "text");
    assert.equal(plain.reached.text[0].model, "text-model");
    assert.equal(pageImages(plain.reached.text[0]), false);
    assert.match(JSON.stringify(plain.reached.text[0].messages), /quarterly report/);
    assert.match(plain.result, /A useful assistant reply/);

    // The placeholder reading (what the compiled primary alone would do) fails closed:
    // no configured model, the decoy included, gets the PDF.
    const check = policy.check.bind(policy);
    policy.check = async () => ({ allow: true, model: placeholder });
    const closed = await read(vision, {}, "placeholder");
    policy.check = check;
    only(closed.reached, null);
    assert.doesNotMatch(closed.result, /A useful assistant reply/);
    // The guard fails closed without AgentPier's answer as well.
    policy.check = async () => ({ allow: false, reason: "unavailable" });
    const refused = await read(vision, {}, "refused");
    policy.check = check;
    only(refused.reached, null);
    assert.match(refused.result, /Reading PDFs is not available right now/);

    // With the owner's fallback the start compiles it; a text-only agent reads with it,
    // an agent whose model takes images still with its own.
    fallback = { connectionId: "fallback", modelId: "fallback-model" };
    running = await start(false);
    assert.deepEqual(running.agents.defaults.pdfModel, {
      primary: "ap-fallback/fallback-model",
      fallbacks: [],
    });
    const helped = await read(text, {}, "text-fallback");
    only(helped.reached, "fallback");
    assert.equal(pageImages(helped.reached.fallback[0]), true);
    const still = await read(vision, {}, "vision-fallback");
    only(still.reached, "vision");
  },
);
