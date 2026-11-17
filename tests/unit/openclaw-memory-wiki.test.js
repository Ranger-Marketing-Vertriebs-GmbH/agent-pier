import test from "node:test";
import assert from "node:assert/strict";
import { compilerFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { desiredState } from "../../server/features/assistants/agent-desired-state.js";
import { RUNTIME_IDS } from "../../server/features/assistants/runtimes/runtime-descriptors.js";
import { agentEntry } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-entry.js";
import {
  agentDrift,
  agentPatch,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-apply.js";
import { mcpLive } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/mcp-live.js";
import { webToolsSnapshot } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/web-tools.js";
import {
  hasWiki,
  hostWiki,
  wikiPlugin,
  wikiTools,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/memory-wiki.js";
import { isLockedPath } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/locked-core.js";
import { nativeTools } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";
import { goldenPaths, goldenScenarios } from "../helpers/openclaw-golden-scenarios.js";

// OpenClaw's memory wiki (ADR 0007, step 7b): the bundled plugin `memory-wiki` loads
// while at least one owner's own agent keeps a wiki, with one vault per agent; its
// five tools reach exactly those agents. Without one the configuration is the one from
// before the option, byte for byte.
const userAccess = {
  mode: "shared",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};
const agent = (id, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  runtimeAgentId: `ap-${id}`,
  revision: 1,
  capabilities: { memory: true },
  ...extra,
});
const wiki = { runtimeOptions: { openclaw: { memoryWiki: true } } };
const ready = { teamsReady: true, nativeReady: true, guardProven: true };
const compile = (profiles) => {
  const scenario = goldenScenarios["no-tools"]();
  return compilerFor(null).compile({
    desired: desiredState({ ...scenario.teams, profiles }),
    existing: {
      agents: {
        defaults: {},
        entries: Object.fromEntries([
          ["main", {}],
          ...profiles.map((p) => [p.runtimeAgentId, {}]),
        ]),
      },
    },
    paths: goldenPaths,
    port: scenario.port,
    token: scenario.token,
    overrides: [],
    runtime: { maintenance: false },
    shell: scenario.shell,
    skillShadows: {},
  });
};

test("the wiki's tools are OpenClaw's five and no other grant or lock names them", () => {
  assert.equal(wikiPlugin, "memory-wiki");
  assert.deepEqual(wikiTools, [
    "wiki_status",
    "wiki_search",
    "wiki_get",
    "wiki_apply",
    "wiki_lint",
  ]);
  for (const tool of wikiTools) {
    assert.equal(nativeTools.includes(tool), false, tool);
    assert.equal(lockedTools.includes(tool), false, tool);
  }
});

test("only an owner's own, live OpenClaw agent with the option keeps a wiki", () => {
  assert.equal(hasWiki(agent("a1", wiki)), true);
  assert.equal(hasWiki(agent("a1")), false);
  const cases = {
    shared: agent("a1", { ...wiki, userAccess }),
    own: agent("a1", { ...wiki, userAccess: { ...userAccess, mode: "own" } }),
    archived: agent("a1", { ...wiki, archivedAt: "2026-11-01T00:00:00Z" }),
    member: agent("a1", {
      ...wiki,
      teamMemberId: "a1",
      parentAssistantId: "lead",
      inherited: { capabilities: {} },
    }),
    elsewhere: agent("a1", {
      runtime: RUNTIME_IDS[1],
      runtimeOptions: { [RUNTIME_IDS[1]]: { memoryWiki: true } },
    }),
  };
  for (const [name, profile] of Object.entries(cases)) {
    assert.equal(hasWiki(profile), false, name);
    assert.equal(hostWiki([profile]), false, name);
    assert.equal(
      agentEntry({}, profile, ready).tools.allow.some((t) => wikiTools.includes(t)),
      false,
      name,
    );
  }
  assert.equal(hostWiki([agent("a1"), agent("a2", wiki)]), true);
});

test("an agent with the wiki holds its five tools once native tools are ready", () => {
  const entry = agentEntry({}, agent("a1", wiki), ready);
  assert.deepEqual(entry.tools.allow.slice(-5), wikiTools);
  // Everything else is exactly what the same agent holds without the wiki.
  assert.deepEqual(
    entry.tools.allow.slice(0, -5),
    agentEntry({}, agent("a1"), ready).tools.allow,
  );
  assert.equal(
    agentEntry({}, agent("a1", wiki), { ...ready, nativeReady: false }).tools.allow.some(
      (t) => wikiTools.includes(t),
    ),
    false,
  );
});

test("without a wiki agent the start compiles exactly what it did before", () => {
  const before = compile([agent("a1"), agent("a2", { userAccess })]);
  // A stored "on" of an agent that may not keep a wiki compiles nothing.
  const refused = compile([agent("a1"), agent("a2", { ...wiki, userAccess })]);
  assert.deepEqual(refused, before);
  assert.equal(JSON.stringify(before).includes("wiki"), false);
});

test("a start loads the plugin with one vault per agent while an agent keeps a wiki", () => {
  const off = compile([agent("a1"), agent("a2")]);
  const on = compile([agent("a1", wiki), agent("a2")]);
  assert.deepEqual(on.plugins.allow, [...off.plugins.allow, wikiPlugin]);
  const entry = on.plugins.entries[wikiPlugin];
  assert.equal(entry.enabled, true);
  const { config } = entry;
  assert.deepEqual(config.vault, { scope: "agent", renderMode: "native" });
  assert.ok(["isolated", "bridge"].includes(config.vaultMode));
  assert.deepEqual(config.obsidian, {
    enabled: false,
    useOfficialCli: false,
    openAfterWrites: false,
  });
  assert.equal(config.ingest.allowUrlIngest, false);
  assert.deepEqual(config.search, { backend: "local", corpus: "wiki" });
  assert.deepEqual(config.context, { includeCompiledDigestPrompt: false });
  // Nothing else of the plugins or the memory changed: no search, no embeddings.
  const { [wikiPlugin]: _wiki, ...entries } = on.plugins.entries;
  assert.deepEqual(entries, off.plugins.entries);
  assert.deepEqual(on.memory, off.memory);
  assert.deepEqual(on.plugins.slots, off.plugins.slots);
  // The global list gains the five tools; the agent's entry holds them, no other.
  assert.deepEqual(on.tools.allow, [...off.tools.allow, ...wikiTools]);
  assert.deepEqual(on.agents.entries["ap-a1"].tools.allow.slice(-5), wikiTools);
  assert.deepEqual(on.agents.entries["ap-a2"], off.agents.entries["ap-a2"]);
  assert.deepEqual(on.agents.entries.main.tools.allow, ["session_status"]);
  // Only AgentPier's compiler writes the entry.
  assert.equal(isLockedPath(`plugins.entries.${wikiPlugin}`), true);
});

const state =
  (extra = {}) =>
  () => ({
    ...ready,
    toolsManaged: true,
    memoryManaged: true,
    managed: true,
    shellGlobal: false,
    ...extra,
  });

test("a live apply moves the agent's tools and the global ones together", () => {
  const config = compile([agent("a1"), agent("a2", wiki)]);
  const desired = desiredState({ profiles: [agent("a1", wiki)] }).agents[0];
  // Another agent keeps a wiki already: the global list holds the tools.
  const on = agentPatch(config, desired, state({ wikiGlobal: true }));
  assert.deepEqual(on.patch.agents.entries["ap-a1"].tools.allow.slice(-5), wikiTools);
  assert.equal(on.patch.tools, undefined);
  // The last one stops: the tools leave the global list.
  const stopped = desiredState({ profiles: [agent("a2")] }).agents[0];
  const off = agentPatch(config, stopped, state({ wikiGlobal: false }));
  assert.deepEqual(
    off.patch.tools.allow,
    compile([agent("a1"), agent("a2")]).tools.allow,
  );
  assert.ok(off.replacePaths.includes("tools.allow"));
  // Unmanaged: nothing of the host moves.
  assert.equal(agentPatch(config, desired, state()).patch.tools, undefined);
});

test("the readback notices a host whose global list lacks the wiki's tools", () => {
  const profile = agent("a1", wiki);
  const config = compile([profile]);
  const desired = desiredState({ profiles: [profile] }).agents[0];
  const expected = {
    managed: true,
    tools: config.agents.entries["ap-a1"].tools.allow,
    skills: [],
    shellGlobal: false,
    wikiGlobal: true,
  };
  assert.equal(agentDrift(config, desired, expected), false);
  const lacking = structuredClone(config);
  lacking.tools.allow = lacking.tools.allow.filter((t) => !wikiTools.includes(t));
  assert.equal(agentDrift(lacking, desired, expected), true);
  assert.equal(agentDrift(config, desired, { ...expected, wikiGlobal: false }), true);
});

test("a live MCP apply writes the same global list a start does", () => {
  for (const profiles of [
    [agent("a1"), agent("a2")],
    [agent("a1", wiki), agent("a2")],
  ]) {
    const start = compile(profiles);
    const desired = desiredState({ ...goldenScenarios["no-tools"]().teams, profiles });
    // What McpChanges.apply builds from the start's web tools snapshot.
    const webTools = webToolsSnapshot({ profiles, webTools: desired.host.webTools });
    const live = mcpLive({ desired, webTools, wiki: hostWiki(desired.agents) });
    assert.deepEqual(live.build(start).patch.tools.allow, start.tools.allow);
  }
});

test("the compiler port answers whether the agents need the plugin", () => {
  const compiler = compilerFor(null);
  assert.equal(compiler.hostWiki([agent("a1")]), false);
  assert.equal(compiler.hostWiki([agent("a1", wiki)]), true);
  assert.deepEqual(
    compiler.wikiTools(agent("a1", wiki), { nativeReady: true }),
    wikiTools,
  );
  assert.deepEqual(compiler.wikiTools(agent("a1"), { nativeReady: true }), []);
  // A restart is needed only while the running start lacks the plugin.
  assert.equal(compiler.optionsRestart([agent("a1", wiki)], { memoryWiki: false }), true);
  assert.equal(compiler.optionsRestart([agent("a1", wiki)], { memoryWiki: true }), false);
  assert.equal(compiler.optionsRestart([agent("a1")], { memoryWiki: false }), false);
});
