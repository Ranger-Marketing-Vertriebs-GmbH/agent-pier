import test from "node:test";
import assert from "node:assert/strict";
import { compilerFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import {
  desiredState,
  isDesiredState,
  withSemanticMemory,
} from "../../server/features/assistants/agent-desired-state.js";
import {
  applySemanticMemory,
  compiledSemantic,
  embeddingPortOffset,
  indexEveryAgent,
  semanticMemorySections,
  withoutSemanticMemory,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/semantic-memory.js";
import { lastCdpOffset } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/browser-profiles.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { goldenPaths, goldenScenarios } from "../helpers/openclaw-golden-scenarios.js";

// What the owner's semantic memory search compiles into openclaw.json
// (openclaw-config/semantic-memory.js; the whole file is the golden fixture
// semantic-memory.json).
const scenario = goldenScenarios["semantic-memory"]();
const { semanticMemory } = scenario;
const compile = (s, desired) =>
  compilerFor(null).compile({
    desired,
    existing: structuredClone(s.existing),
    paths: goldenPaths,
    port: s.port,
    token: s.token,
    overrides: s.overrides,
    runtime: { maintenance: s.maintenance },
    shell: s.shell,
    skillShadows: s.skillShadows,
  });
const on = () =>
  compile(scenario, withSemanticMemory(desiredState(scenario.teams), semanticMemory));
const off = () => compile(scenario, desiredState(scenario.teams));

test("off is the default: keyword search, no plugin, no provider, no fallback", () => {
  const config = off();
  assert.deepEqual(config.memory.search, {
    enabled: false,
    provider: "none",
    sources: ["memory"],
    rememberAcrossConversations: false,
  });
  assert.equal(config.plugins.allow.includes("llama-cpp"), false);
  assert.deepEqual(config.plugins.load.paths, ["/golden/plugin"]);
  // The provider entry an earlier start wrote is removed; the owner's stay.
  assert.deepEqual(Object.keys(config.models.providers), ["p"]);
  assert.equal(compiledSemantic(config), false);
});

test("off changes nothing of a configuration that never had it", () => {
  const s = goldenScenarios.shell();
  const desired = desiredState(s.teams);
  // Without the setting the desired state is the stores' own object.
  assert.equal(withSemanticMemory(desired, undefined), desired);
  const config = compile(s, desired);
  assert.equal("models" in config, false);
  assert.equal(JSON.stringify(config).includes("llama"), false);
});

test("on compiles local embeddings that never download and never leave loopback", () => {
  const config = on();
  assert.equal(compiledSemantic(config), true);
  // The memory search itself: the local provider, an absolute model file (a path is
  // only checked, never fetched) and no other provider to fall back to.
  assert.deepEqual(config.memory.search, {
    enabled: false,
    provider: "local",
    sources: ["memory"],
    rememberAcrossConversations: false,
    fallback: "none",
    local: { modelPath: semanticMemory.model },
  });
  assert.equal(config.memory.search.remote, undefined);
  // Each agent's own switch is untouched.
  assert.equal(config.agents.entries["ap-a1"].memory.search.enabled, true);
  assert.equal(config.agents.entries["ap-a2"].memory.search.enabled, false);
  // The plugin is on the restrictive allow list and loaded from the locked runtime.
  assert.equal(config.plugins.allow.at(-1), "llama-cpp");
  assert.equal(config.plugins.load.paths.at(-1), semanticMemory.plugin.directory);
  assert.equal(config.plugins.slots.memory, "memory-core");
  const provider = config.models.providers["llama-cpp"];
  const port = scenario.port + embeddingPortOffset;
  assert.equal(embeddingPortOffset, lastCdpOffset + 1);
  assert.equal(provider.baseUrl, `http://127.0.0.1:${port}/v1`);
  assert.deepEqual(provider.models, []);
  // The folder and file name by which the plugin recognises its default model.
  assert.equal(provider.params.modelCacheDir, semanticMemory.modelCacheDir);
  assert.equal(
    semanticMemory.model,
    `${semanticMemory.modelCacheDir}/${runtimeManifest.embeddingModel.file}`,
  );
  const service = provider.localService;
  // Not the plugin's own managed installation path, so it never installs a build.
  assert.equal(service.command, "/bin/sh");
  assert.deepEqual(service.args.slice(2), [
    "agentpier-embedding-server",
    semanticMemory.pidFile,
    semanticMemory.command,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--models-preset",
    semanticMemory.preset,
    "--models-max",
    "1",
    "--no-ui",
  ]);
  assert.equal(service.healthUrl, `http://127.0.0.1:${port}/health`);
  assert.equal(service.idleStopMs, 600000);
  // The owner's other provider and no key anywhere.
  assert.deepEqual(config.models.providers.p, { baseUrl: "http://127.0.0.1:9" });
  assert.equal(JSON.stringify(provider).includes("apiKey"), false);
});

test("the start script writes the pid of the process that becomes the server", () => {
  const { provider } = semanticMemorySections({ semanticMemory, port: 1000 });
  assert.equal(provider.localService.args[0], "-c");
  assert.equal(provider.localService.args[1], 'echo "$$" > "$1" && shift && exec "$@"');
});

test("the state with the setting is a frozen desired state of its own", () => {
  const base = desiredState(scenario.teams);
  const next = withSemanticMemory(base, semanticMemory);
  assert.ok(isDesiredState(next));
  assert.notEqual(next, base);
  assert.equal(base.host.semanticMemory, undefined);
  assert.deepEqual(next.host.semanticMemory, semanticMemory);
  assert.ok(Object.isFrozen(next.host) && Object.isFrozen(next.host.semanticMemory));
  assert.equal(next.agents, base.agents);
  // The stores' reads are built into a state first (a fixture's teamConfiguration).
  assert.ok(isDesiredState(withSemanticMemory(scenario.teams, semanticMemory)));
});

test("relative or missing paths and another plugin are refused", () => {
  for (const patch of [
    { model: "models/x.gguf" },
    { command: undefined },
    { pidFile: "" },
    { plugin: { id: "llama-cpp", directory: "plugin" } },
    { plugin: { id: "other", directory: "/p" } },
  ])
    assert.throws(
      () =>
        semanticMemorySections({
          semanticMemory: { ...semanticMemory, ...patch },
          port: 1,
        }),
      TypeError,
    );
  assert.equal(semanticMemorySections({ semanticMemory: undefined, port: 1 }), null);
});

test("without a native team start nothing of it is compiled", () => {
  const s = goldenScenarios["teams-without-native"]();
  const config = compile(s, withSemanticMemory(desiredState(s.teams), semanticMemory));
  assert.equal(config.memory, undefined);
  assert.equal(JSON.stringify(config).includes("llama"), false);
});

test("the keyword fallback of a compiled start is the start compiled without it", () => {
  assert.deepEqual(withoutSemanticMemory(on()), off());
  // A configuration without it passes through, as a copy.
  const plain = off();
  const copy = withoutSemanticMemory(plain);
  assert.deepEqual(copy, plain);
  assert.notEqual(copy, plain);
});

test("applying it twice keeps one provider and one allow entry per start", () => {
  const sections = semanticMemorySections({ semanticMemory, port: 2000 });
  const config = applySemanticMemory(off(), sections);
  assert.equal(config.plugins.allow.filter((id) => id === "llama-cpp").length, 1);
  assert.equal(config.models.providers["llama-cpp"].baseUrl, "http://127.0.0.1:2111/v1");
});

test("the index rebuild's copy switches memory on for every managed agent only", () => {
  const config = on();
  const copy = indexEveryAgent(config);
  assert.equal(copy.agents.entries["ap-a2"].memory.search.enabled, true);
  assert.equal(copy.agents.entries["ap-a1"].memory.search.enabled, true);
  // OpenClaw's own main agent is none of AgentPier's.
  assert.equal(copy.agents.entries.main.memory, undefined);
  assert.equal(config.agents.entries["ap-a2"].memory.search.enabled, false);
  assert.deepEqual({ ...copy, agents: 0 }, { ...config, agents: 0 });
});
