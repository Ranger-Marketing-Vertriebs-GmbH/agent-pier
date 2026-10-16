import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectAssistantServices,
  constructAssistantGraph,
} from "../../server/application/assistant-graph.js";
import { createAssistantServices } from "../../server/application/assistants.js";
import { webToolsSnapshot } from "../../server/features/assistants/openclaw-config/web-tools.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { ASSISTANT_WIRING_INCOMPLETE } from "../../server/features/assistants/service-wiring.js";

function options(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "assistant-wiring-")),
  );
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { config: { dataDir }, providerConnections: { list: () => [] } };
}
async function release(graph) {
  await graph.assistantChannels?.close().catch(() => {});
  await graph.assistantTeams?.close().catch(() => {});
  await graph.assistantWorkflows?.close().catch(() => {});
  await graph.assistants?.close().catch(() => {});
}
const incomplete = (name) => ({
  code: ASSISTANT_WIRING_INCOMPLETE,
  message: new RegExp(name),
});

test("a graph missing a service fails at connect time with an explicit error", async (t) => {
  const graph = constructAssistantGraph(options(t));
  t.after(() => release(graph));
  const { bridge } = graph;
  delete graph.bridge;
  assert.throws(() => connectAssistantServices(graph), incomplete("bridge"));
  await bridge.close();
});

test("a graph service used before connect reports missing wiring, not undefined", async (t) => {
  const graph = constructAssistantGraph(options(t));
  t.after(() => release(graph));
  assert.throws(() => graph.assistantRuntime.start(), incomplete("teamConfiguration"));
  assert.throws(() => graph.assistants.list(), incomplete("teams"));
  assert.throws(() => graph.assistantTeams.list(), incomplete("bridge"));
  await assert.rejects(graph.configuration.apply("missing"), incomplete("teamReady"));
});

test("createAssistantServices returns a graph whose every reference is connected", async (t) => {
  const services = createAssistantServices(options(t));
  t.after(() => release(services));
  const {
    assistants,
    assistantTeams,
    assistantReminders,
    assistantRoutines,
    assistantWorkflows,
    assistantProviderSynchronization,
    assistantRuntime,
    assistantUpdates,
  } = services;
  assert.equal(assistants.teams, assistantTeams);
  assert.equal(assistants.reminders, assistantReminders);
  assert.equal(assistants.routines, assistantRoutines);
  assert.equal(assistants.workflows, assistantWorkflows);
  assert.equal(assistants.providerSynchronization, assistantProviderSynchronization);
  assert.equal(assistants.webTools, services.assistantWebTools);
  assert.equal(
    services.assistantWebTools.synchronization,
    assistantProviderSynchronization,
  );
  assert.ok(assistantTeams.bridge);
  // A guard report re-applies the agents a fresh start compiled without writes.
  assert.equal(typeof assistantTeams.bridge.onGuard, "function");
  assert.ok(assistantUpdates);
  for (const hook of ["teamConfiguration", "maintenance", "beforeSpawn", "afterReady"])
    assert.equal(typeof assistantRuntime[hook], "function", hook);
  for (const hook of [
    "teamReady",
    "writeGuard",
    "hostCapacity",
    "nativeReady",
    "webToolsAvailable",
    "shellPathPrepend",
    "mcpTools",
  ])
    assert.equal(typeof assistants.config[hook], "function", hook);
  // Live applies prepend the PATH the running Gateway was started with.
  assistantRuntime.shell = { pathPrepend: ["/owner/bin"] };
  assert.deepEqual(assistants.config.shellPathPrepend(), ["/owner/bin"]);
  assistantRuntime.shell = null;
  // MCP globs follow the last start's snapshot; before any start, none.
  const agent = { runtimeAgentId: "ap-x" };
  assert.deepEqual(assistants.config.mcpTools(agent), []);
  assistantRuntime.mcp = { agentTools: { "ap-x": ["docs__*"] } };
  assert.deepEqual(assistants.config.mcpTools(agent), ["docs__*"]);
  assert.ok(services.assistantMcpServers);
  // Live applies see what the last start compiled; before any start, nothing.
  assert.deepEqual(assistants.config.webToolsAvailable(), {
    browser: false,
    webSearch: false,
  });
  assistantRuntime.webTools = webToolsSnapshot({
    profiles: [],
    webTools: {
      search: { provider: "duckduckgo", requiresPlugin: true },
      browser: { available: true, executablePath: "/usr/bin/chromium" },
      searchPlugins: { duckduckgo: { id: "duckduckgo", directory: "/rt/ddg" } },
    },
  });
  assert.deepEqual(assistants.config.webToolsAvailable(), {
    browser: true,
    webSearch: true,
  });
  assert.equal(assistants.maintenance, false);
  // Connected services work without recovery having run.
  assert.deepEqual(assistants.list().assistants, []);
  // The workflow timer starts in the recovery step, not at construction.
  assert.equal(assistantWorkflows.timer, undefined);
});

test("a ready Gateway with a live write guard re-applies the memory agents", async (t) => {
  const services = createAssistantServices(options(t));
  t.after(() => release(services));
  const { assistants, assistantTeams, assistantRuntime } = services;
  const applied = [];
  assistantTeams.bridge.guardLive = () => true;
  assistantRuntime.status = () => ({ availability: "ready" });
  assistants.store.listAssistants = () => [
    { id: "home", capabilities: { memory: true } },
    { id: "plain", capabilities: { memory: false } },
  ];
  assistants.config.apply = async (id) => applied.push(id);
  // A guard reported during the start: readiness (gatewayEvents.ready) runs the pass.
  assistants.gatewayEvents.ready();
  for (let n = 0; n < 50 && !applied.length; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(applied, ["home"]);
});

test("a failed construction releases every opened service one after another", async (t) => {
  const settings = options(t);
  // A file where the speech database belongs fails construction after the teams.
  fs.writeFileSync(path.join(settings.config.dataDir, "speech"), "not a folder");
  const events = [];
  for (const [name, Service] of [
    ["bridge", TeamBridge],
    ["teams", TeamService],
    ["assistants", AssistantService],
  ]) {
    const close = Service.prototype.close;
    t.mock.method(Service.prototype, "close", async function () {
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await close.call(this);
      events.push(`end ${name}`);
    });
  }
  let failure;
  try {
    createAssistantServices(settings);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  await failure.released;
  assert.deepEqual(events, [
    "start bridge",
    "end bridge",
    "start teams",
    "end teams",
    "start assistants",
    "end assistants",
  ]);
});

test("the graph binds SSH host removal to the agents and unbinds it on close", async (t) => {
  const sshManagement = { onAccessChanged: null };
  const graph = constructAssistantGraph({ ...options(t), sshManagement });
  t.after(() => release(graph));
  assert.equal(sshManagement.onAccessChanged, graph.assistantWorkflows.ssh.hook);
  await graph.assistantWorkflows.close();
  assert.equal(sshManagement.onAccessChanged, null);
});
