import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "./process-guard.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CentralMcpChanges } from "../../server/features/mcp-servers/central-changes.js";
import { McpOAuthLogins } from "../../server/features/mcp-servers/mcp-oauth-logins.js";
import { oauthRedirect } from "../../server/features/mcp-servers/oauth-redirect.js";
import {
  McpCliError,
  supervisorMcpCli,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-mcp-cli.js";
import { readMcpInputs } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/mcp-servers.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtimes/openclaw/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import {
  mcpOAuthCallbackRoutes,
  mcpOAuthRoutes,
} from "../../server/http/routes/mcp-oauth.js";
import {
  assistantModelServer,
  offeredToolNames,
  discoveredToolNames,
} from "./assistant-model-server.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";

import { OfflineCommands } from "../../server/features/assistants/runtimes/openclaw/offline-commands.js";

// AgentPier's own MCP OAuth path for assistant-mcp-oauth-compiled-contract.test.js.
const mcpTools = (offered) => offered.filter((n) => n.includes("__")).sort();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Closes each resource in turn, even when an earlier one throws. */
async function closeAll(steps) {
  const [first, ...rest] = steps;
  if (!first) return;
  try {
    await first();
  } finally {
    await closeAll(rest);
  }
}

/**
 * The application's assistant services on a provisioned Gateway in team mode, wired
 * as server/application/assistant-graph.js wires them, with the MCP server routes
 * and the OAuth callback served on a loopback listener: that listener's port is the
 * compiled redirect, as AgentPier's own listener is. `logouts.fail` makes the CLI
 * wrapper's logouts fail as a timed-out CLI would.
 */
export async function harness(t, { tool, installed, contractDir }) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-oauth-compiled-"));
  const store = new AssistantStore({ dataDir });
  const servers = new McpServerStore({ dataDir });
  const model = await assistantModelServer({ tool, discover: "echo" });
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
  const lease = () => ({
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
  });
  const models = { resolve: lease, listCapabilities: () => [] };
  const config = new AssistantConfig({
    store,
    models,
    workspaces: runtime.paths.workspaces,
    runtime,
    hostCapacity: () => 4,
  });
  const assistants = new AssistantService({ store, runtime, config, models });
  // AgentPier's listener: the routes, and the port the redirect is compiled with.
  const app = express();
  const listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const redirectUrl = () => oauthRedirect({ port: listener.address().port });

  // The real CLI wrapper; `logouts.fail` stands in for a CLI that times out. The
  // callback reports only a code, so `failures` keeps the (redacted) CLI messages.
  const logouts = { fail: false, calls: [] };
  const failures = [];
  // OpenClaw 2026.10.10 and later sign in and out only in a maintenance window, as
  // the application wires it (offline-commands-wiring.js; no pending restart here).
  const offline = new OfflineCommands({ supervisor: runtime, forget: async () => {} });
  const realCli = supervisorMcpCli(runtime, { offline: (task) => offline.run(task) });
  const loginStarts = { count: 0 };
  const cli = {
    ...realCli,
    startLogin: (...args) => {
      loginStarts.count++;
      return realCli.startLogin(...args);
    },
    completeLogin: (...args) =>
      realCli.completeLogin(...args).catch((error) => {
        failures.push(`${error.code}: ${error.message}`);
        throw error;
      }),
    logout(name, opts) {
      logouts.calls.push({ name, failed: logouts.fail });
      if (logouts.fail)
        return Promise.reject(new McpCliError("cli-timeout", "The CLI timed out."));
      return realCli.logout(name, opts);
    },
  };
  const oauth = new McpOAuthLogins({
    cli,
    servers,
    runtime,
    admit: (operation) => assistants.admit(operation),
    redirectUrl,
    reapply: () => mcp.apply(),
    onFreed: () => assistants.admit(() => mcp.apply()),
    offline,
  });
  const mcp = (assistants.mcp = new McpChanges({
    assistants,
    servers,
    redirectUrl,
    oauth,
  }));
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
    webToolsAvailable: () => runtime.webTools?.availability || {},
    mcpTools: (a) => runtime.mcp?.agentTools?.[a.runtimeAgentId] || [],
  });
  const starts = { beforeDrain: null };
  runtime.teamConfiguration = async (descriptor) => {
    teams.mcp.sync();
    starts.beforeDrain?.();
    await mcp.drainLogouts();
    return {
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "mcp-oauth-compiled-fixture" },
      profiles: store.listAssistants(),
      mcp: readMcpInputs(servers, { redirectUrl: mcp.redirectUrl() }),
      webTools: {
        search: { provider: "duckduckgo" },
        browser: { available: false },
        searchPlugins: descriptor.searchPlugins || {},
      },
    };
  };
  runtime.afterReady = async () => {
    mcp.ready();
    if (mcp.pending) await assistants.admit(() => mcp.apply()).catch(() => {});
  };
  // As in the application (server/application/services.js and routes/assistants.js):
  // the routes change servers through CentralMcpChanges, which hands them to the
  // agents' McpChanges, audit each change, and the login routes sit beside them.
  const audit = [];
  const services = {
    mcpServerChanges: new CentralMcpChanges({ servers, agents: () => mcp }),
    assistantMcpOAuth: oauth,
    audit: { append: (entry) => audit.push(entry) },
  };
  app.use("/api", mcpOAuthCallbackRoutes(services));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use("/api", mcpServerRoutes(services));
  app.use("/api", mcpOAuthRoutes(services));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ code: error.code, error: error.message }),
  );
  t.after(() =>
    closeAll([
      () => offline.close(),
      () => oauth.close(),
      // Closes the team service and its bridge, the runtime and the agent store.
      () => assistants.close(),
      () => model.close(),
      () => servers.close(),
      () =>
        new Promise((r) => {
          listener.closeAllConnections();
          listener.close(r);
        }),
      () => fs.rmSync(dataDir, { recursive: true, force: true }),
    ]),
  );

  // After a window: its start settled, and each agent applied again (the start
  // compiles no provider; the application's reconcile would apply them).
  const settle = async (generation) => {
    await offline.idle();
    if (runtime.generation === generation || !runtime.client?.ready) return;
    config.reset();
    for (const agent of store.listAssistants()) await config.apply(agent.id);
  };
  const api = async (method, route, body) => {
    const generation = runtime.generation;
    const res = await fetch(`${base}/api${route}`, {
      method,
      redirect: "manual",
      headers: {
        origin: base,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    await settle(generation);
    return {
      status: res.status,
      headers: res.headers,
      body: text ? JSON.parse(text) : null,
    };
  };
  const listed = async (name) =>
    (await api("GET", "/mcp-servers")).body.find((s) => s.name === name);
  // OpenClaw's own view of the login, read through the wrapper.
  const authState = async (name) => (await realCli.status())[name]?.state;
  // No login left: `unauthenticated`, or `pending-authorization` with every flag false
  // once a Gateway MCP request reached the server after the logout (its 401 records
  // the challenge; assistant-mcp-oauth-contract.test.js (e) tolerates the same).
  const loggedOut = async (name, message = name) => {
    const { state, ...flags } = (await realCli.status())[name];
    assert.deepEqual(
      flags,
      { hasTokens: false, requiresAuthorization: false, hasClientInformation: false },
      message,
    );
    assert.ok(["unauthenticated", "pending-authorization"].includes(state), state);
  };
  // One turn on a new session of `agent`: the tools offered and the last tool result.
  async function turn(agent, label) {
    const from = model.requests.length;
    const session = await createGatewaySession(runtime.client, {
      agentId: agent.runtimeAgentId,
      label,
    });
    const sent = await runtime.client.call("sessions.send", {
      key: session.key,
      message: `Use the tool. ${label}`,
      idempotencyKey: `${label}-${from}`,
    });
    const done = await runtime.client.call(
      "agent.wait",
      { runId: sent.runId, timeoutMs: 60000 },
      { timeoutMs: 65000 },
    );
    assert.equal(done.status, "ok", label);
    const requests = model.requests
      .slice(from)
      .filter((r) => JSON.stringify(r.messages).includes(`Use the tool. ${label}`));
    const result = requests
      .flatMap((r) => r.messages || [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content))
      .at(-1);
    const offered = mcpTools([
      ...offeredToolNames(requests[0]),
      ...discoveredToolNames(requests),
    ]);
    t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
    return { offered, result };
  }
  const running = async () => (await runtime.client.call("config.get", {})).config;
  return {
    offline,
    settle,
    store,
    servers,
    runtime,
    config,
    audit,
    assistants,
    mcp,
    oauth,
    logouts,
    failures,
    loginStarts,
    starts,
    redirectUrl,
    api,
    listed,
    authState,
    loggedOut,
    cliStatus: () => realCli.status(),
    turn,
    running,
  };
}
