import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  desiredState,
  isDesiredAgent,
} from "../../server/features/assistants/agent-desired-state.js";
import { grantedTools } from "../../server/features/assistants/native-capabilities.js";
import { goldenPaths } from "./openclaw-golden-scenarios.js";

// What every runtime gets of a start besides the desired state; runtimes that do
// not need a fact ignore it.
// `existing`: the configuration an earlier start and the agent's creation left.
const startFacts = {
  existing: { agents: { entries: { "ap-a1": {} } } },
  paths: goldenPaths,
  port: 18000,
  token: "t",
};
const plugin = {
  directory: "/contract/plugin",
  connection: { url: "http://127.0.0.1:1", token: "bridge" },
  native: { token: "hook" },
  hostMaxConcurrent: 2,
};
const agent = (extra = {}) => ({
  id: "a1",
  name: "Agent",
  runtimeAgentId: "ap-a1",
  capabilities: {},
  ...extra,
});
// What the runtime offers an apply now (agent-apply.js agentPatch's state).
const ready = {
  teamsReady: true,
  nativeReady: true,
  guardProven: true,
  toolsManaged: true,
  memoryManaged: true,
  available: {},
  pathPrepend: [],
  mcpTools: [],
  senderFacing: false,
  shadowedSkills: [],
  managed: true,
};
const expectedOf = (desired) => ({
  managed: true,
  tools: grantedTools(desired.tools, {
    teamsReady: true,
    nativeReady: true,
    writeGuard: true,
  }),
  skills: desired.skills.compiled,
  memory: desired.memory,
});

/**
 * The configuration compiler's contract (ADR 0006, decision 3), for every runtime's
 * compiler with or without a host: it compiles AgentPier's desired state
 * (agent-desired-state.js) the same way every time without changing it, and its
 * advanced settings exist exactly when the runtime offers the capability. `make()`
 * resolves `{ compiler, capabilities }` (the capabilities() map, or the part the
 * config sub-port decides).
 */
export function compilerContract(name, make) {
  test(`${name}: the compiler compiles a desired state alike every time, leaving it as it was`, async () => {
    const { compiler } = await make();
    const desired = desiredState({ ...plugin, profiles: [agent()] });
    const before = JSON.stringify(desired);
    const first = compiler.compile({ desired, ...startFacts });
    assert.equal(typeof first, "object");
    assert.deepEqual(compiler.compile({ desired, ...startFacts }), first);
    assert.equal(JSON.stringify(desired), before);
    assert.ok(Object.isFrozen(desired) && Object.isFrozen(desired.agents[0]));
    // Another desired state compiles to another configuration.
    const memory = desiredState({
      ...plugin,
      profiles: [agent({ capabilities: { memory: true } })],
    });
    assert.notDeepEqual(compiler.compile({ desired: memory, ...startFacts }), first);
  });

  test(`${name}: advanced settings exist exactly when the runtime offers them`, async () => {
    const { compiler, capabilities } = await make();
    const { advancedSettings } = compiler;
    if (!capabilities.advancedSettings.available) {
      assert.equal(advancedSettings, undefined);
      return;
    }
    assert.ok(advancedSettings.list.length > 0);
    const [first] = advancedSettings.list;
    assert.equal(advancedSettings.byPath(first.path), first);
    assert.equal(advancedSettings.byId(first.id), first);
    assert.throws(() => advancedSettings.validate("gateway.auth.token", "x"));
  });
}

/**
 * The config sub-port's desired-state contract (ADR 0006, decision 3), for the
 * runtime port contract (runtime-port-contract.js): the compiler's contract
 * (compilerContract), and an agent's desired state applied live reads back as
 * applied until it changes.
 */
export function configContract(name, make) {
  compilerContract(name, async () => {
    const runtime = await make({});
    return { compiler: runtime.config.compiler, capabilities: runtime.capabilities() };
  });

  test(`${name}: an agent's desired state applies live and reads back until it changes`, async () => {
    const runtime = await make({});
    const { config, agents } = runtime;
    await agents.create({ name: "ap-a1", workspace: "/w/a1", model: "m/1" });
    const [plain] = desiredState({ profiles: [agent()] }).agents;
    const [memory] = desiredState({
      profiles: [agent({ capabilities: { memory: true } })],
    }).agents;
    assert.ok(isDesiredAgent(plain));
    const applied = async (desired) =>
      config.applied({
        desired,
        config: (await config.get()).config,
        expected: expectedOf(desired),
      });
    await config.apply({ desired: plain, state: () => ready });
    assert.equal(await applied(plain), true);
    assert.equal(await applied(memory), false);
    await config.apply({ desired: memory, state: () => ready });
    assert.equal(await applied(memory), true);
    assert.equal(await applied(plain), false);
  });
}

/**
 * The fake runtime's compiler and live apply over its in-memory configuration
 * (`port`: the fake config sub-port): an agent compiles to its granted tools, shell
 * level and skills, and runs without advanced settings.
 */
export function fakeDesiredConfig(port) {
  const entryOf = (desired, state) => ({
    tools: grantedTools(desired.tools, {
      teamsReady: state.teamsReady,
      nativeReady: state.nativeReady,
      writeGuard: state.guardProven,
      available: state.available,
      mcpTools: state.mcpTools,
    }),
    shell: desired.shell.level,
    skills: state.nativeReady
      ? desired.skills.compiled.filter((name) => !state.shadowedSkills?.includes(name))
      : [],
    memory: !!state.nativeReady && desired.memory,
  });
  return {
    compiler: Object.freeze({
      compile: ({ desired }) => {
        const team = desired.host.team;
        const state = { teamsReady: !!team.plugin, nativeReady: !!team.native };
        return {
          agents: Object.fromEntries(
            desired.agents.map((a) => [a.runtimeAgentId, entryOf(a, state)]),
          ),
        };
      },
    }),
    applyModel: ({ desired }) =>
      port.patch({
        build: () => ({ patch: { models: { [desired.runtimeAgentId]: desired.model } } }),
      }),
    apply: ({ desired, state }) =>
      port.patch({
        build: () => ({
          patch: { agents: { [desired.runtimeAgentId]: entryOf(desired, state()) } },
        }),
      }),
    applied: ({ desired, config, expected }) => {
      const own = config?.agents?.[desired.runtimeAgentId];
      return (
        !!own &&
        isDeepStrictEqual(own.tools, expected.tools) &&
        own.shell === desired.shell.level &&
        isDeepStrictEqual(own.skills, expected.skills) &&
        (expected.memory === undefined || own.memory === expected.memory)
      );
    },
  };
}
