import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { connectSemanticMemory } from "../../server/application/semantic-memory-wiring.js";
import {
  desiredState,
  isDesiredState,
} from "../../server/features/assistants/agent-desired-state.js";
import {
  markerFile,
  stateFile,
} from "../../server/features/assistants/runtimes/openclaw/semantic-memory.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { writePrivate } from "../../server/lib/storage.js";

// How the assistant graph connects the owner's semantic memory search
// (server/application/semantic-memory-wiring.js): around the Gateway supervisor's
// start hooks, to the restart of the provider synchronization and to the live hub.
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-memory-wiring-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const runtime = Object.assign(new EventEmitter(), {
    paths: runtimePaths(dataDir),
    runtime: {
      version: "2026.11.6",
      embeddingPlugin: { id: "llama-cpp", directory: "/p" },
    },
    teamConfiguration: async (installed) => {
      calls.push(["teamConfiguration", installed.version]);
      return desiredState({ profiles: [] });
    },
    beforeSpawn: async () => {
      calls.push(["beforeSpawn"]);
      return "prepared";
    },
  });
  const invalidated = [];
  const graph = {
    assistantRuntime: runtime,
    assistantProviderSynchronization: {
      restartGateway: async (operation, options) => {
        calls.push(["restartGateway", await operation(), options]);
      },
    },
  };
  const memory = connectSemanticMemory(graph, () => ({
    invalidate: (topic) => invalidated.push(topic),
  }));
  return { runtime, memory, calls, invalidated };
}

test("off, a start's desired state is the stores' own and its hooks still run", async (t) => {
  const f = fixture(t);
  const state = await f.runtime.teamConfiguration(f.runtime.runtime);
  assert.ok(isDesiredState(state));
  assert.equal(state.host.semanticMemory, undefined);
  // The index reconcile runs before the start's own preparation, whose answer stays.
  f.memory.beforeSpawn = async () => f.calls.push(["reconcile"]);
  assert.equal(await f.runtime.beforeSpawn(), "prepared");
  assert.deepEqual(f.calls, [
    ["teamConfiguration", "2026.11.6"],
    ["reconcile"],
    ["beforeSpawn"],
  ]);
});

test("on and usable, the start's desired state carries what local embeddings need", async (t) => {
  const f = fixture(t);
  writePrivate(path.join(f.runtime.paths.root, stateFile), {
    enabled: true,
    revision: 2,
  });
  f.memory.assets.installedServer = () => ({ command: "/s" });
  f.memory.assets.installedModel = () => ({ path: "/m" });
  const state = await f.runtime.teamConfiguration(f.runtime.runtime);
  assert.equal(state.host.semanticMemory.plugin.id, "llama-cpp");
  assert.ok(path.isAbsolute(state.host.semanticMemory.model));
  // A runtime without the plugin compiles keyword search and says why.
  const old = await f.runtime.teamConfiguration({ version: "2026.11.3" });
  assert.equal(old.host.semanticMemory, undefined);
  assert.equal(f.memory.status().failure.code, "RUNTIME_UPDATE_REQUIRED");
});

test("the switch restarts like Restart now, and changes reach the live topic", async (t) => {
  const f = fixture(t);
  await f.memory.restart();
  assert.deepEqual(f.calls, [["restartGateway", null, { force: true }]]);
  // The service's own changes and the Gateway's status both signal the topic.
  f.invalidated.length = 0;
  f.memory.changed();
  f.runtime.emit("status", { availability: "ready" });
  assert.deepEqual(f.invalidated, ["runtime.semantic-memory", "runtime.semantic-memory"]);
  // Without a hub (before it listens) a change is no error.
  const quiet = fixture(t);
  connectSemanticMemory({
    assistantRuntime: quiet.runtime,
    assistantProviderSynchronization: {},
  }).changed();
});

test("searches tell whether embeddings answer: AgentPier's own, the owner's look and an agent's search", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-memory-wiring-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const asked = [];
  let answer = { provider: "local", results: [] };
  const agent = (id, extra = {}) => ({
    id,
    runtimeAgentId: `ap-${id}`,
    capabilities: { memory: true },
    ...extra,
  });
  const runtime = Object.assign(new EventEmitter(), {
    paths: runtimePaths(dataDir),
    runtime: {
      version: "2026.11.6",
      embeddingPlugin: { id: "llama-cpp", directory: "/p" },
    },
    teamConfiguration: async () => desiredState({ profiles: [] }),
    beforeSpawn: async () => {},
    status: () => ({ availability: "ready" }),
    // The Gateway's client, as the port's memory search reaches it.
    client: {
      ready: true,
      call: async (method, params) => {
        asked.push([method, params.agentId, params.args]);
        if (params.agentId === "ap-broken") throw new Error("unavailable");
        return { ok: true, output: { details: answer } };
      },
    },
  });
  const assistants = {
    store: {
      listAssistants: () => [
        agent("a1"),
        agent("broken"),
        agent("quiet", { capabilities: { memory: false } }),
        agent("old", { archivedAt: "2026-11-01" }),
        agent("h1", { runtime: "hermes" }),
        agent("a2"),
      ],
    },
  };
  const memory = connectSemanticMemory({
    assistantRuntime: runtime,
    assistantProviderSynchronization: {},
    assistants,
  });
  // On, with indexes built for local embeddings and both assets in place.
  writePrivate(path.join(runtime.paths.root, stateFile), { enabled: true, revision: 2 });
  writePrivate(path.join(runtime.paths.state, markerFile), { mode: "local", model: "x" });
  memory.assets.installedServer = () => ({ command: "/s" });
  memory.assets.installedModel = () => ({ path: "/m" });
  assert.equal(memory.status().state, "on");
  // The owner opens the Runtime tab: one search without hits per OpenClaw agent
  // with memory; an agent that cannot be asked is passed over. Once per process.
  await memory.opened();
  await memory.opened();
  assert.deepEqual(
    asked.map(([method, id, args]) => [method, id, args.maxResults]),
    [
      ["tools.invoke", "ap-a1", 1],
      ["tools.invoke", "ap-broken", 1],
      ["tools.invoke", "ap-a2", 1],
    ],
  );
  assert.match(asked[0][2].query, /^agentpier-embedding-check-/);
  assert.equal(memory.status().state, "on");
  // A search AgentPier issues itself reports its answer; a Hermes agent's does not.
  assistants.memorySearched({ id: "h1", runtime: "hermes" }, { provider: "none" });
  assert.equal(memory.status().state, "on");
  assistants.memorySearched(agent("a1"), { provider: "none", results: [] });
  assert.equal(memory.status().state, "degraded");
  assistants.memorySearched(agent("a1"), { provider: "local", results: [{ path: "x" }] });
  assert.equal(memory.status().state, "on");
  // An agent's own search that ended checks again, at most every ten minutes, and
  // stops at the first answer without embeddings.
  asked.length = 0;
  await assistants.onMemorySearch();
  assert.deepEqual(asked, [], "checked moments ago");
  memory.checkedAt -= 11 * 60000;
  answer = { provider: "none", results: [] };
  await assistants.onMemorySearch();
  assert.deepEqual(
    asked.map(([, id]) => id),
    ["ap-a1"],
  );
  assert.deepEqual(memory.status().degraded.code, "EMBEDDINGS_UNAVAILABLE");
  // Without a ready Gateway nothing is asked.
  runtime.client.ready = false;
  memory.health = memory.checkedAt = null;
  asked.length = 0;
  await memory.opened();
  assert.deepEqual(asked, []);
});
