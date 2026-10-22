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
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { readMcpInputs } from "../../server/features/assistants/openclaw-config/mcp-servers.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { assistantModelServer } from "../helpers/assistant-model-server.js";
import {
  endStdioServers,
  httpMcpServer,
  leakedFiles,
  stdioMcpScript,
  stdioRecords,
} from "../helpers/mcp-test-servers.js";
import { createGatewaySession } from "../../server/features/assistants/session-create.js";

// The installation provisioned by scripts/provision-assistant-contracts.mjs. Unlike
// assistant-mcp-contract.test.js, which patches `mcp` by hand to qualify OpenClaw,
// this contract drives AgentPier's own path: the server store, the agent and team
// services, the start compile and McpChanges' live patches, all in team mode.
const installed = process.env.AGENTPIER_MCP_CONTRACT_RUNTIME;
const contractDir = process.env.AGENTPIER_ASSISTANT_CONTRACT_DIR;
const options = {
  skip:
    !(installed && contractDir) &&
    "set AGENTPIER_MCP_CONTRACT_RUNTIME and AGENTPIER_ASSISTANT_CONTRACT_DIR",
  timeout: contractTimeout(300000),
};

const headerValue = "mcp-compiled-header-4721";
const rotatedValue = "mcp-compiled-header-4722";
const envValue = "mcp-compiled-env-4723";
const fixture = { connectionId: "fixture", modelId: "fixture-model" };
const mcpTools = (offered) => offered.filter((n) => n.includes("__")).sort();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The application's assistant services on a provisioned Gateway in team mode, wired
 * as server/application/assistant-graph.js wires them. `tool` chooses the model's
 * tool call per request.
 */
async function harness(t, { tool }) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(contractDir));
  const node = (await selectedAssistantRuntime({ dataDir: contractDir })).nodePath;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-mcp-compiled-"));
  const store = new AssistantStore({ dataDir });
  // A bare `node` resolves on this PATH, as on the service's own PATH.
  const servers = new McpServerStore({ dataDir, pathEnv: path.dirname(node) });
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
  const mcp = (assistants.mcp = new McpChanges({ assistants, servers }));
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
  runtime.teamConfiguration = async (descriptor) => {
    teams.mcp.sync();
    return {
      directory: descriptor.teamPlugin.directory,
      connection: await bridge.start(),
      hostMaxConcurrent: 4,
      native: { token: "mcp-compiled-fixture" },
      profiles: store.listAssistants(),
      mcp: readMcpInputs(servers),
      webTools: {
        search: { provider: "duckduckgo" },
        browser: { available: false },
        searchPlugins: descriptor.searchPlugins || {},
      },
    };
  };
  t.after(async () => {
    try {
      // Closes the team service and its bridge, the runtime and the agent store.
      await assistants.close();
      await model.close();
      servers.close();
    } finally {
      for (const name of fs.readdirSync(dataDir))
        if (name.endsWith(".jsonl")) await endStdioServers(path.join(dataDir, name));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const create = (name) =>
    store.createAssistant({ name, instructions: "Use the tool.", model: fixture });
  const bind = (agent, ids, extra = {}) =>
    assistants.update(
      agent.id,
      { mcpServers: ids, ...extra },
      store.getAssistant(agent.id).revision,
    );

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
    // Only this session's requests: a team's own turns may run meanwhile.
    const requests = model.requests
      .slice(from)
      .filter((r) => JSON.stringify(r.messages).includes(`Use the tool. ${label}`));
    const result = requests
      .flatMap((r) => r.messages || [])
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content))
      .at(-1);
    const offered = (requests[0]?.tools ?? []).map((d) => d.function.name);
    t.diagnostic(`${label} offered=${JSON.stringify(offered)} result=${result}`);
    return { offered, result };
  }
  const running = async () => (await runtime.client.call("config.get", {})).config;
  const allowOf = async (agent) =>
    (await running()).agents.entries[agent.runtimeAgentId]?.tools?.allow || [];
  return {
    dataDir,
    node,
    store,
    servers,
    model,
    runtime,
    config,
    assistants,
    mcp,
    teams,
    create,
    bind,
    turn,
    running,
    allowOf,
  };
}

test(
  "bound MCP servers compile at the start and follow live changes without a restart",
  options,
  async (t) => {
    const http = await httpMcpServer();
    t.after(() => http.close());
    // Each turn calls the tool its message names, when that tool is offered.
    const tool = (input) => {
      const text = JSON.stringify(input.messages);
      const name = ["docs__echo", "local__echo"].find((n) => text.includes(`CALL ${n}`));
      return name && { name, arguments: { text: `via-${name}` } };
    };
    const h = await harness(t, { tool });
    const { servers, mcp, runtime, turn, allowOf, running } = h;
    const record = path.join(h.dataDir, "stdio-record.jsonl");
    const bound = h.create("Bound");
    const other = h.create("Other");

    // The owner's path: create both servers and bind them before the start.
    const docs = await mcp.create({
      name: "docs",
      transport: "http",
      url: http.url,
      headers: { "X-Fixture-Marker": headerValue },
    });
    await assert.rejects(
      mcp.create({ name: "local", transport: "stdio", command: "node" }),
      { code: "MCP_STDIO_CONFIRMATION_REQUIRED" },
    );
    const local = await mcp.create(
      {
        name: "local",
        transport: "stdio",
        command: "node",
        args: [stdioMcpScript, record],
        env: { MCP_FIXTURE_SECRET: envValue },
      },
      { confirmStdio: true },
    );
    // The bare command was resolved to the absolute path the Gateway needs.
    assert.equal(local.command, path.join(path.dirname(h.node), "node"));
    assert.equal(JSON.stringify(servers.list()).includes(headerValue), false);
    assert.equal(JSON.stringify(servers.list()).includes(envValue), false);
    await h.bind(bound, [docs.id, local.id], { confirmStdio: true });
    assert.deepEqual(
      servers.bindings("agent", bound.id).sort(),
      [docs.id, local.id].sort(),
    );

    await runtime.start();
    await h.config.apply(bound.id);
    await h.config.apply(other.id);
    assert.equal(runtime.status().availability, "ready");
    const generation = runtime.generation;
    const log = path.join(runtime.paths.logs, "gateway-console.log");
    const logFrom = fs.statSync(log).size;

    // The start compiled exactly the bound servers, with the global grant and the
    // bound agent's globs, under the team plugin's restrictive plugins.allow.
    assert.deepEqual(runtime.mcp.servers, ["docs", "local"]);
    assert.deepEqual(runtime.mcp.agentTools, {
      [bound.runtimeAgentId]: ["docs__*", "local__*"],
    });
    const compiled = await running();
    assert.ok(compiled.plugins.allow.includes("agentpier-teams"));
    assert.equal(compiled.plugins.allow.includes("bundle-mcp"), false);
    assert.ok(compiled.tools.allow.includes("bundle-mcp"));
    assert.deepEqual(Object.keys(compiled.mcp.servers), ["docs", "local"]);
    assert.equal(compiled.mcp.servers.docs.transport, "streamable-http");
    assert.equal(compiled.mcp.servers.docs.url, http.url);
    assert.notEqual(compiled.mcp.servers.docs.headers["X-Fixture-Marker"], headerValue);
    assert.equal(compiled.mcp.servers.local.command, local.command);
    assert.deepEqual(compiled.mcp.servers.local.args, [stdioMcpScript, record]);
    assert.notEqual(compiled.mcp.servers.local.env.MCP_FIXTURE_SECRET, envValue);
    assert.ok((await allowOf(bound)).includes("docs__*"));
    assert.ok((await allowOf(bound)).includes("local__*"));
    assert.equal(
      (await allowOf(other)).some((n) => n.includes("__")),
      false,
    );

    // The bound agent is offered both tools and reaches both servers; the other
    // agent is offered neither.
    assert.deepEqual(mcpTools((await turn(bound, "bound")).offered), [
      "docs__echo",
      "local__echo",
    ]);
    assert.deepEqual(mcpTools((await turn(other, "other")).offered), []);
    assert.equal((await turn(bound, "CALL docs__echo")).result, "echo:via-docs__echo");
    assert.equal(http.calls.at(-1).headers["x-fixture-marker"], headerValue);
    assert.equal((await turn(bound, "CALL local__echo")).result, "echo:via-local__echo");
    const stdioCalls = () => stdioRecords(record).filter((e) => e.event === "call");
    assert.deepEqual(
      stdioCalls().map((c) => c.text),
      ["via-local__echo"],
    );
    assert.ok(
      stdioRecords(record).every(
        (e) => e.event !== "start" || e.env.MCP_FIXTURE_SECRET === "set",
      ),
    );
    // The other agent's attempt to call a server it is not bound to cannot run.
    await turn(other, "CALL local__echo");
    assert.equal(stdioCalls().length, 1);

    // Live: binding the HTTP server to the other agent patches the running Gateway.
    await h.bind(other, [docs.id]);
    assert.deepEqual(runtime.mcp.agentTools[other.runtimeAgentId], ["docs__*"]);
    assert.ok((await allowOf(other)).includes("docs__*"));
    assert.deepEqual(mcpTools((await turn(other, "other-bound")).offered), [
      "docs__echo",
    ]);

    // Live: a rotated header reaches the server on the next call.
    await mcp.update(docs.id, {
      revision: servers.get(docs.id).revision,
      headers: { "X-Fixture-Marker": rotatedValue },
    });
    assert.equal((await turn(other, "CALL docs__echo")).result, "echo:via-docs__echo");
    assert.equal(http.calls.at(-1).headers["x-fixture-marker"], rotatedValue);

    // Live: removing the stdio server (null merge plus its args in replacePaths)
    // drops it from the configuration and the agent, and its processes end.
    const started = stdioRecords(record).filter((e) => e.event === "start");
    assert.ok(started.length > 0);
    await mcp.remove(local.id);
    const removed = await running();
    assert.deepEqual(Object.keys(removed.mcp.servers), ["docs"]);
    assert.deepEqual(runtime.mcp.agentTools[bound.runtimeAgentId], ["docs__*"]);
    assert.equal((await allowOf(bound)).includes("local__*"), false);
    for (let n = 0; n < 50 && started.some((s) => alive(s.pid)); n++) await delay(100);
    assert.deepEqual(
      started.filter((s) => alive(s.pid)).map((s) => s.pid),
      [],
      "removed server's processes",
    );
    assert.deepEqual(mcpTools((await turn(bound, "bound-after-removal")).offered), [
      "docs__echo",
    ]);

    // Live: removing the last server takes the global grant and every glob with it.
    await mcp.remove(docs.id);
    const empty = await running();
    assert.deepEqual(Object.keys(empty.mcp?.servers || {}), []);
    assert.equal(empty.tools.allow.includes("bundle-mcp"), false);
    assert.equal(
      (await allowOf(bound)).some((n) => n.includes("__")),
      false,
    );
    assert.deepEqual(mcpTools((await turn(bound, "bound-none")).offered), []);

    // None of it restarted the Gateway.
    assert.equal(runtime.generation, generation);
    assert.equal(runtime.status().availability, "ready");
    assert.doesNotMatch(
      fs.readFileSync(log, "utf8").slice(logFrom),
      /requires gateway restart/,
    );
    // The owner's server store holds the values by design; nothing else does.
    assert.deepEqual(
      leakedFiles(
        h.dataDir,
        [headerValue, rotatedValue, envValue],
        [path.join(h.dataDir, "mcp-servers")],
      ),
      [],
    );
  },
);

test(
  "a lead passes its MCP server to an approved temporary member until the member ends",
  options,
  async (t) => {
    const http = await httpMcpServer();
    t.after(() => http.close());
    const proposal = {
      objective: "Review the documentation",
      members: [
        {
          name: "Reviewer",
          role: "Review",
          assignment: "Review the documentation with the docs server.",
          mcpServers: ["docs"],
        },
      ],
    };
    // The lead proposes through the team plugin tool; an agent without team tools
    // (the member) calls the docs server.
    const tool = (input) => {
      const names = (input.tools || []).map((d) => d.function.name);
      if (names.includes("agentpier_team_propose"))
        return JSON.stringify(input.messages).includes("PROPOSE_TEAM")
          ? { name: "agentpier_team_propose", arguments: proposal }
          : null;
      return { name: "docs__echo", arguments: { text: "from-member" } };
    };
    const h = await harness(t, { tool });
    const { store, servers, mcp, runtime, assistants, teams, turn, allowOf } = h;
    const lead = h.create("Lead");
    const docs = await mcp.create({
      name: "docs",
      transport: "http",
      url: http.url,
      headers: { "X-Fixture-Marker": headerValue },
    });
    await h.bind(lead, [docs.id]);
    await runtime.start();
    const generation = runtime.generation;
    // Waits for `check`, ticking the services as their timers would.
    const until = async (check, label) => {
      for (const deadline = Date.now() + 120000; !(await check());) {
        assert.ok(Date.now() < deadline, `timed out: ${label}`);
        await teams.reconcile().catch(() => {});
        await assistants.reconcile().catch(() => {});
        await delay(250);
      }
    };

    // The lead's own turn proposes the team through the plugin tool; without the
    // owner's permission in that turn it awaits approval.
    const chat = await assistants.openConversation(lead.id);
    const sent = await assistants.send(chat.id, {
      clientRequestId: "lead-proposal",
      text: "PROPOSE_TEAM",
    });
    await until(
      () => assistants.ledger.getAttempt(sent.attempt.id).state === "completed",
      "lead turn",
    );
    const leadRequest = h.model.requests.find((r) =>
      JSON.stringify(r.messages).includes("PROPOSE_TEAM"),
    );
    const leadOffered = leadRequest.tools.map((d) => d.function.name);
    assert.ok(leadOffered.includes("agentpier_team_propose"));
    assert.ok(leadOffered.includes("docs__echo"));
    const [team] = teams.store.list();
    assert.equal(team.phase, "awaiting_approval");
    const listed = teams.list().teams.find((x) => x.id === team.id);
    assert.deepEqual(listed.members[0].mcpServers, [{ name: "docs", stdio: false }]);

    // The owner approves; the member is bound to the lead's server, provisioned with
    // its glob, and its turn calls the server.
    await teams.decide(
      team.id,
      { revision: team.revision, decision: "approve", lifetime: "task" },
      { kind: "owner", channel: "ui" },
    );
    const [member] = teams.store.members(team.id);
    const agent = store.getAssistant(member.assistantId);
    assert.deepEqual(servers.bindings("agent", agent.id), [docs.id]);
    await until(
      () => http.calls.some((c) => c.text === "from-member"),
      "member's call to the docs server",
    );
    assert.equal(
      http.calls.find((c) => c.text === "from-member").headers["x-fixture-marker"],
      headerValue,
    );
    const memberRequest = h.model.requests.find(
      (r) =>
        JSON.stringify(r.messages).includes(proposal.members[0].assignment) &&
        !(r.tools || []).some((d) => d.function.name === "agentpier_team_propose"),
    );
    assert.deepEqual(mcpTools(memberRequest.tools.map((d) => d.function.name)), [
      "docs__echo",
    ]);

    // Once the member ends, its binding, its glob and its tools are gone, while the
    // lead keeps the server.
    await until(
      async () =>
        teams.store.member(member.id).phase === "completed" &&
        !servers.bindings("agent", agent.id).length &&
        !runtime.mcp.agentTools[agent.runtimeAgentId],
      "member end",
    );
    assert.equal(
      (await allowOf(agent)).some((n) => n.includes("__")),
      false,
    );
    assert.ok((await allowOf(lead)).includes("docs__*"));
    assert.deepEqual(mcpTools((await turn(agent, "ended-member")).offered), []);
    assert.equal(http.calls.filter((c) => c.text === "from-member").length, 1);
    assert.equal(runtime.generation, generation, "no restart");
    assert.deepEqual(
      leakedFiles(h.dataDir, [headerValue], [path.join(h.dataDir, "mcp-servers")]),
      [],
    );
  },
);
