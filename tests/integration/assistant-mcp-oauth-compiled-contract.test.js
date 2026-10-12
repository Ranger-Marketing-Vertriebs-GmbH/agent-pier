import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
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
} from "../../server/features/mcp-servers/openclaw-mcp-cli.js";
import { readMcpInputs } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { mcpServerRoutes } from "../../server/http/routes/mcp-servers.js";
import {
  mcpOAuthCallbackRoutes,
  mcpOAuthRoutes,
} from "../../server/http/routes/mcp-oauth.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import { approve, oauthMcpServer } from "../helpers/mcp-oauth-test-server.js";

// The installation provisioned by scripts/provision-assistant-contracts.mjs. Unlike
// assistant-mcp-oauth-contract.test.js, which runs the OpenClaw CLI by hand to
// qualify OpenClaw, this contract drives AgentPier's own path: the server store, the
// start compile and McpChanges' live patches, McpOAuthLogins with its CLI wrapper on
// the Gateway's private state, and the HTTP routes including the OAuth callback.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: 400000,
};

const fixture = { connectionId: "fixture", modelId: "fixture-model" };
const mcpTools = (offered) => offered.filter((n) => n.includes("__")).sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function harness(t, { tool }) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-oauth-compiled-"));
  const store = new AssistantStore({ dataDir });
  const servers = new McpServerStore({ dataDir });
  const model = await assistantModelServer({ tool });
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
    client: { call: (...args) => runtime.client.call(...args) },
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

  // The real CLI wrapper; `logouts.fail` stands in for a CLI that times out.
  const logouts = { fail: false, calls: [] };
  const realCli = supervisorMcpCli(runtime);
  const cli = {
    ...realCli,
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

  const api = async (method, route, body) => {
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

  // One turn on a new session of `agent`: the tools offered and the last tool result.
  async function turn(agent, label) {
    const from = model.requests.length;
    const session = await runtime.client.call("sessions.create", {
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
    const offered = mcpTools((requests[0]?.tools ?? []).map((d) => d.function.name));
    t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
    return { offered, result };
  }
  const running = async () => (await runtime.client.call("config.get", {})).config;
  return {
    store,
    servers,
    runtime,
    config,
    audit,
    assistants,
    mcp,
    oauth,
    logouts,
    starts,
    redirectUrl,
    api,
    listed,
    authState,
    cliStatus: () => realCli.status(),
    turn,
    running,
  };
}

test(
  "an OAuth MCP server logs in through AgentPier's callback and its tools reach the agent",
  options,
  async (t) => {
    const docsServer = await oauthMcpServer();
    t.after(() => docsServer.close());
    // Bound to the same agent and never logged in.
    const spareServer = await oauthMcpServer();
    t.after(() => spareServer.close());
    const tool = (input) => {
      const text = JSON.stringify(input.messages);
      return text.includes("CALL docs__echo")
        ? { name: "docs__echo", arguments: { text: "via-oauth" } }
        : null;
    };
    const h = await harness(t, { tool });
    const { servers, runtime, api, listed, authState, turn, running } = h;
    const grants = () => docsServer.log.filter((e) => e.grant).map((e) => e.grant);
    const agent = h.store.createAssistant({
      name: "Bound",
      instructions: "Use the tool.",
      model: fixture,
    });

    // The owner's path: create both OAuth servers over HTTP and bind them.
    const created = await api("POST", "/mcp-servers", {
      name: "docs",
      transport: "http",
      url: docsServer.url,
      auth: "oauth",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const docs = created.body;
    const spare = (
      await api("POST", "/mcp-servers", {
        name: "spare",
        transport: "http",
        url: spareServer.url,
        auth: "oauth",
      })
    ).body;
    assert.deepEqual(
      h.audit.map((e) => [e.action, e.resourceId]),
      [
        ["mcp.created", docs.id],
        ["mcp.created", spare.id],
      ],
    );
    await h.assistants.update(
      agent.id,
      { mcpServers: [docs.id, spare.id] },
      h.store.getAssistant(agent.id).revision,
    );

    await runtime.start();
    await h.config.apply(agent.id);
    assert.equal(runtime.status().availability, "ready");
    const generation = runtime.generation;

    // The start compiled both with AgentPier's loopback redirect and no headers.
    const redirectUrl = h.redirectUrl();
    assert.deepEqual(runtime.mcp.servers, ["docs", "spare"]);
    assert.equal(runtime.mcp.redirectUrl, redirectUrl);
    const compiled = (await running()).mcp.servers;
    for (const [name, server] of [
      ["docs", docsServer],
      ["spare", spareServer],
    ]) {
      assert.equal(compiled[name].url, server.url);
      assert.equal(compiled[name].auth, "oauth");
      assert.deepEqual(compiled[name].oauth, { redirectUrl });
      assert.equal(compiled[name].headers, undefined);
    }
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.equal(await authState("docs"), "unauthenticated");

    // Without credentials the turn runs, offers no tools, and backs both servers off.
    assert.deepEqual((await turn(agent, "before-login")).offered, []);
    assert.ok(docsServer.log.some((e) => e.path === "/mcp" && e.rejected === "missing"));
    // The failed start leaves pending-authorization without a registered client: a
    // server never logged in still reads "not connected".
    assert.deepEqual((await h.cliStatus()).docs, {
      state: "pending-authorization",
      hasTokens: false,
      requiresAuthorization: false,
      hasClientInformation: false,
    });
    h.oauth.invalidate();
    assert.equal((await listed("docs")).oauthStatus, "not-connected");

    // Login start through the route: OpenClaw prints the URL for the compiled redirect.
    // The first token is stale at once within OpenClaw's 30 s expiry skew.
    docsServer.state.expiresIn = 31;
    const started = await api("POST", `/mcp-servers/${docs.id}/oauth/login`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.status, "authorize");
    const authorizationUrl = new URL(started.body.authorizationUrl);
    assert.equal(authorizationUrl.origin, docsServer.origin);
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), redirectUrl);
    assert.equal((await listed("docs")).oauthStatus, "login-pending");

    // The browser follows the URL; the provider redirects to AgentPier's callback.
    const callback = await approve(authorizationUrl.href);
    assert.equal(`${callback.origin}${callback.pathname}`, redirectUrl);
    const completed = await fetch(callback, { redirect: "manual" });
    assert.equal(completed.status, 303);
    assert.equal(
      completed.headers.get("location"),
      `/accounts?oauth=connected&server=${docs.id}`,
    );
    docsServer.state.expiresIn = 3600;
    // The state is single use.
    const replayed = await fetch(callback, { redirect: "manual" });
    assert.equal(replayed.status, 303);
    assert.equal(
      replayed.headers.get("location"),
      "/accounts?oauth=error&reason=state-invalid",
    );
    const connected = await listed("docs");
    assert.equal(connected.oauthStatus, "connected");
    assert.ok(Number.isFinite(connected.oauthExpiresAt));
    assert.equal(await authState("docs"), "authorized");
    assert.equal((await listed("spare")).oauthStatus, "not-connected");
    // The post-login nudge: a hot `mcp` change that lifts the failed start's backoff.
    assert.equal((await running()).mcp.sessionIdleTtlMs, 0);

    // The next turn, within the backoff window of the failed one, is offered the tool;
    // OpenClaw refreshed the stale token unattended. The spare server stays out.
    await sleep(1500);
    assert.deepEqual(grants(), ["authorization_code"]);
    assert.deepEqual((await turn(agent, "after-login")).offered, ["docs__echo"]);
    assert.ok(grants().includes("refresh_token"), JSON.stringify(grants()));
    assert.equal((await turn(agent, "CALL docs__echo")).result, "echo:via-oauth");
    assert.equal(docsServer.calls.length, 1);
    assert.match(docsServer.calls[0].bearer, /^at-/);
    // A server-side expiry: OpenClaw refreshes and retries the call unattended.
    docsServer.expireAccessTokens();
    const before = grants().length;
    const logBefore = docsServer.log.length;
    const again = await turn(agent, "CALL docs__echo again");
    // The server log tells a missed refresh from a dropped retry.
    assert.equal(
      again.result,
      "echo:via-oauth",
      JSON.stringify({ ...again, server: docsServer.log.slice(logBefore) }),
    );
    assert.deepEqual(grants().slice(before), ["refresh_token"]);
    assert.equal(spareServer.log.filter((e) => e.path === "/token").length, 0);

    // Logout through the route: tokens gone, tools gone.
    const out = await api("POST", `/mcp-servers/${docs.id}/oauth/logout`);
    assert.equal(out.status, 204);
    assert.equal(await authState("docs"), "unauthenticated");
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.deepEqual((await turn(agent, "after-logout")).offered, []);

    // Each login: start, approve, callback; the nudge makes the next turn see it.
    async function login(label) {
      const begun = await api("POST", `/mcp-servers/${docs.id}/oauth/login`);
      assert.equal(begun.body.status, "authorize", label);
      const back = await approve(begun.body.authorizationUrl);
      const done = await fetch(back, { redirect: "manual" });
      assert.equal(done.status, 303, label);
      assert.match(done.headers.get("location"), /oauth=connected/, label);
      assert.equal((await listed("docs")).oauthStatus, "connected", label);
    }
    await login("second");
    assert.deepEqual((await turn(agent, "second-login")).offered, ["docs__echo"]);

    // A rename logs out under the old name before it is saved: renaming back finds no
    // login, where OpenClaw alone keeps the orphaned row (oauth contract (e)).
    const rename = async (name) => {
      const res = await api("PUT", `/mcp-servers/${docs.id}`, {
        name,
        revision: servers.get(docs.id).revision,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    };
    const renamed = await rename("renamed");
    assert.equal(renamed.oauthWarning, undefined);
    assert.deepEqual(runtime.mcp.servers, ["renamed", "spare"]);
    assert.equal(await authState("renamed"), "unauthenticated");
    assert.deepEqual((await turn(agent, "renamed")).offered, []);
    await rename("docs");
    assert.deepEqual(runtime.mcp.servers, ["docs", "spare"]);
    assert.equal(await authState("docs"), "unauthenticated", "old login gone");
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.equal(runtime.generation, generation, "no restart");

    // A logout that fails is deferred: the rename is saved, the server with the old
    // name and URL stays uncompiled, and the next start drains it before compiling.
    await login("third");
    await runtime.stop();
    h.logouts.fail = true;
    const moved = await rename("moved");
    assert.equal(moved.oauthWarning.code, "oauth-logout-deferred");
    await rename("docs");
    assert.ok(
      servers
        .deferredLogouts()
        .some((d) => d.name === "docs" && d.url === docsServer.url),
    );
    const held = await listed("docs");
    assert.equal(held.oauthStatus, "login-required");
    assert.equal(held.oauthReason.code, "logout-pending");
    // The real logouts resume only when the start drains them.
    h.starts.beforeDrain = () => {
      h.logouts.fail = false;
      h.starts.beforeDrain = null;
    };
    const drainedFrom = h.logouts.calls.length;
    await runtime.start();
    await h.config.apply(agent.id);
    assert.ok(
      h.logouts.calls.slice(drainedFrom).some((c) => c.name === "docs" && !c.failed),
      JSON.stringify(h.logouts.calls),
    );
    assert.deepEqual(servers.deferredLogouts(), []);
    assert.deepEqual(runtime.mcp.servers, ["docs", "spare"]);
    assert.equal(await authState("docs"), "unauthenticated", "drained at the start");
    assert.equal((await listed("docs")).oauthStatus, "not-connected");
    assert.deepEqual((await turn(agent, "after-drain")).offered, []);

    // A login after the drain works as the first did.
    await login("after-drain");
    assert.deepEqual((await turn(agent, "fourth-login")).offered, ["docs__echo"]);
  },
);
