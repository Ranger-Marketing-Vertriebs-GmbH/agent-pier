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
  assert.ok(assistantTeams.bridge);
  assert.ok(assistantUpdates);
  for (const hook of ["teamConfiguration", "maintenance", "beforeSpawn", "afterReady"])
    assert.equal(typeof assistantRuntime[hook], "function", hook);
  for (const hook of ["teamReady", "writeGuard", "hostCapacity", "nativeReady"])
    assert.equal(typeof assistants.config[hook], "function", hook);
  assert.equal(assistants.maintenance, false);
  // Connected services work without recovery having run.
  assert.deepEqual(assistants.list().assistants, []);
  // The workflow timer starts in the recovery step, not at construction.
  assert.equal(assistantWorkflows.timer, undefined);
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
