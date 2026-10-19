import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { guardProcess } from "./process-guard.js";
import { proactivityModel } from "./assistant-proactivity-model.js";
import {
  connectAssistantServices,
  constructAssistantGraph,
} from "../../server/application/assistant-graph.js";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { ProviderCatalog } from "../../server/features/providers/provider-catalog.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { McpTools } from "../../server/features/mcp/tool-service.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import { PipelineEngine } from "../../server/features/pipelines/pipeline-engine.js";

/**
 * The production assistant graph (server/application/assistant-graph.js, constructed
 * and connected as AgentPier does) on the pinned runtime in a disposable data
 * directory, with the owner's HTTP routes mounted on a loopback server. Only the
 * edges are doubles: the model is a scripted OpenAI-compatible endpoint reached
 * through a real provider connection (`h.model.reply`), the coding run is AgentPier's
 * real PipelineEngine with a stub stage driver that writes a passing verdict (no
 * coding CLI, no tmux), and the owner's shell environment is a temporary home.
 * Nothing leaves the machine.
 */
export async function e2eGraph(t, installed, { prefix }) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const owner = path.join(dataDir, "owner-home");
  fs.mkdirSync(owner);
  const model = await proactivityModel();
  const audit = [],
    pushes = [];
  const providerCatalog = new ProviderCatalog({ dataDir });
  const providerConnections = new ProviderConnections({ dataDir });
  const memory = new ProjectMemory({ dataDir, home: owner });
  const pipelines = codingPipeline(dataDir);
  const host = {
    config: { dataDir },
    providerCatalog,
    providerConnections,
    audit: { append: (entry) => audit.push(entry) },
    notifications: { notify: async (input) => pushes.push(input) },
    memory,
    mutationBarrier: new MutationBarrier(),
    pipelineDefinitions: pipelines.definitions,
    pipelines: pipelines.engine,
    assistantFeature: { enabled: true },
  };
  host.mcpTools = new McpTools(host);
  const graph = connectAssistantServices(constructAssistantGraph(host));
  // Every service the routes look up, host services included (the routes spread it).
  const services = { ...host, ...graph };
  const runtime = graph.assistantRuntime;
  runtime.install = async () => ({
    version: runtimeManifest.version,
    nodePath: path.join(installed, "node/bin/node"),
    entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    searchPlugins: {},
    teamPlugin: provisionTeamPlugin({
      paths: runtime.paths,
      runtimeVersion: runtimeManifest.version,
    }),
  });
  runtime.shellOwner = () => ({ home: owner, pathPrepend: [] });
  const spawn = runtime.spawn;
  runtime.spawn = (...args) => {
    const child = spawn(...args);
    guardProcess(t, child);
    return child;
  };
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(assistantRoutes(services));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code,
      key: error.key,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const state = { closed: false };
  t.after(async () => {
    // A held model reply stops waiting before the services close.
    state.closed = true;
    try {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await graph.assistantWorkflows.close().catch(() => {});
      await graph.assistantChannels.close().catch(() => {});
      for (const closable of [graph.assistantWebSearch, graph.assistantPdfModel])
        try {
          closable.close();
        } catch {
          /* Closed already. */
        }
      graph.assistantMcpOAuth.close();
      graph.assistantMcpServers.close();
      await graph.assistants.close();
      host.mcpTools.close();
      await pipelines.engine.close();
      memory.close();
      providerConnections.close?.();
      await model.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const started = Date.now();
  const events = [];
  const h = {
    dataDir,
    owner,
    model,
    audit,
    pushes,
    services,
    graph,
    runtime,
    memory,
    pipelines,
    events,
    /** Records one observed step with its offset from the start, for the evidence. */
    note(step) {
      events.push({ ms: Date.now() - started, step });
    },
    /** One owner request to AgentPier's own routes; the parsed answer. */
    async http(method, url, body) {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      });
      const value = await response.json().catch(() => null);
      assert.ok(
        response.ok,
        `${method} ${url} answered ${response.status}: ${JSON.stringify(value)}`,
      );
      return value;
    },
    async until(check, label, { timeoutMs = 90000 } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        if (state.closed) throw Error(`closed while waiting: ${label}`);
        const value = await check();
        if (value) return value;
        if (Date.now() > end) assert.fail(`timed out: ${label}`);
        await delay(200);
      }
    },
    /** The scripted model behind a real endpoint provider connection. */
    connection() {
      return providerConnections.create({
        providerId: "endpoint",
        name: "Fixture endpoint",
        endpoint: {
          preset: "custom",
          openaiBaseUrl: model.url,
          authHeader: null,
          protocols: { messages: false, responses: false, chatCompletions: true },
          models: [
            {
              modelId: "fixture-model",
              source: "manual",
              contextTokens: 32768,
              outputTokens: 4096,
            },
          ],
        },
      });
    },
    /** Starts the Gateway as the opt-in start does and waits until it is ready. */
    async start() {
      await runtime.start();
      graph.assistantWorkflows.start();
      assert.equal(runtime.status().availability, "ready");
    },
    /** The chat as the browser reads it. */
    history: (conversationId) =>
      h.http("GET", `/assistant-conversations/${conversationId}/messages`),
  };
  return h;
}

/** The text of the request's last user message and the tool results after it. */
export function turnOf(request) {
  const messages = request.messages || [];
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === "user") last = i;
  });
  const text = (value) =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((part) => part.text || "").join("")
        : "";
  return {
    user: last < 0 ? "" : text(messages[last].content),
    results: messages
      .slice(last + 1)
      .filter((m) => m.role === "tool")
      .map((m) => text(m.content)),
    tools: (request.tools || []).map((tool) => tool.function?.name),
  };
}

/**
 * A one-stage coding pipeline ("Build", profile "Coder") on AgentPier's real engine.
 * The stage driver launches nothing: it writes a passing verdict and an artifact
 * into the run's workspace shortly after the start and reports the turn completed.
 */
function codingPipeline(dataDir) {
  const dir = path.join(dataDir, "pipeline-runs");
  fs.mkdirSync(dir);
  const profile = {
    id: "profile",
    name: "Coder",
    revision: 1,
    config: {
      cliTool: "codex",
      accountId: "account",
      prompts: { kickoff: "Perform {{task}}", role: "" },
      models: { default: "model" },
      permissions: { mode: "default" },
      run: { autonomous: true },
    },
  };
  const pipeline = {
    id: "pipeline",
    name: "Build",
    revision: 1,
    graph: {
      entry: "code",
      nodes: [{ id: "code", kind: "profile", profileId: "profile" }],
      edges: [],
    },
  };
  const launches = [],
    outcomes = new Map();
  const state = { projectId: null };
  const driver = {
    async start(input) {
      launches.push(input);
      outcomes.set(input.sessionId, { status: "running" });
      setTimeout(() => {
        fs.writeFileSync(path.join(input.cwd, "result.txt"), "E2E build artifact\n");
        const verdict = path.join(input.cwd, input.verdictPath);
        fs.writeFileSync(
          verdict,
          JSON.stringify({
            result: "pass",
            summary: "E2E_RUN_SUMMARY build fixed",
            artifacts: [{ path: "result.txt", label: "Result" }],
          }),
        );
        // Whole seconds: a fresh verdict never predates its turn (pipeline-engine.js).
        const at = Math.ceil(Date.now() / 1000);
        fs.utimesSync(verdict, at, at);
        outcomes.set(input.sessionId, { status: "completed", exitCode: 0 });
      }, 300).unref();
      return { sessionId: input.sessionId };
    },
    async inspect(input) {
      return outcomes.get(input.sessionId) || { status: "missing" };
    },
    async cancel(input) {
      outcomes.set(input.sessionId, { status: "failed", exitCode: 130 });
    },
  };
  const workspace = {
    async prepare({ runId }) {
      const cwd = path.join(dir, runId);
      fs.mkdirSync(cwd);
      return {
        cwd,
        projectRoot: dir,
        projectId: state.projectId,
        branch: `agentpier/${runId}`,
        baseSha: "abc",
      };
    },
    async remove() {},
  };
  const engine = new PipelineEngine({
    dataDir,
    definitions: {
      snapshot: () => ({
        pipeline: structuredClone(pipeline),
        profiles: { profile: structuredClone(profile) },
      }),
      getVerification: () => ({ steps: [] }),
    },
    driver,
    workspace,
    pollIntervalMs: 250,
  });
  return {
    engine,
    launches,
    state,
    pipeline,
    profile,
    definitions: {
      listPipelines: () => [structuredClone(pipeline)],
      getPipeline: () => structuredClone(pipeline),
      getProfile: () => structuredClone(profile),
    },
  };
}
