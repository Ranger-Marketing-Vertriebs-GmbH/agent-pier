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
import {
  hostLearns,
  learningTool,
  learningTools,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/skill-learning.js";
import { openClawSkills } from "../../server/features/assistants/runtimes/openclaw/openclaw-skills.js";
import { skillCatalog } from "../../server/features/assistants/agent-skills.js";
import { isLockedPath } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/locked-core.js";
import { nativeTools } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";
import { goldenPaths, goldenScenarios } from "../helpers/openclaw-golden-scenarios.js";

// "Learns its own skills" on OpenClaw (docs/tools/self-learning.md of the pinned
// runtime): the review mode is Gateway-wide, the only per-agent lever is the tool
// `skill_workshop`. An agent that learns holds the tool; the mode is "auto" while at
// least one agent does, else "off" as before the field existed.
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

test("the tool is skill_workshop and no other grant or lock names it", () => {
  assert.equal(learningTool, "skill_workshop");
  assert.equal(nativeTools.includes(learningTool), false);
  assert.equal(lockedTools.includes(learningTool), false);
});

test("an agent that learns holds the tool, and only once native tools are ready", () => {
  const on = agent("a1", { skillLearning: true });
  assert.deepEqual(learningTools(on, { nativeReady: true }), [learningTool]);
  assert.deepEqual(learningTools(on, { nativeReady: false }), []);
  assert.deepEqual(learningTools(agent("a1"), { nativeReady: true }), []);
  const entry = agentEntry({}, on, ready);
  assert.equal(entry.tools.allow.at(-1), learningTool);
  // Everything else is exactly what the same agent holds without learning.
  assert.deepEqual(
    entry.tools.allow.slice(0, -1),
    agentEntry({}, agent("a1"), ready).tools.allow,
  );
  assert.equal(
    agentEntry({}, on, { ...ready, nativeReady: false }).tools.allow.includes(
      learningTool,
    ),
    false,
  );
});

test("no user agent, archived agent, task member or bot for other people learns", () => {
  const cases = {
    shared: agent("a1", { skillLearning: true, userAccess }),
    own: agent("a1", { skillLearning: true, userAccess: { ...userAccess, mode: "own" } }),
    archived: agent("a1", { skillLearning: true, archivedAt: "2026-11-01T00:00:00Z" }),
    member: agent("a1", {
      skillLearning: true,
      teamMemberId: "a1",
      parentAssistantId: "lead",
      inherited: { capabilities: {} },
    }),
  };
  for (const [name, profile] of Object.entries(cases)) {
    assert.deepEqual(learningTools(profile, { nativeReady: true }), [], name);
    assert.equal(
      agentEntry({}, profile, ready).tools.allow.includes(learningTool),
      false,
      name,
    );
    assert.equal(hostLearns([profile]), false, name);
  }
  // Its background review reads the agent's other sessions: other people's chats.
  const on = agent("a1", { skillLearning: true });
  assert.equal(
    agentEntry({}, on, { ...ready, senderFacing: true }).tools.allow.includes(
      learningTool,
    ),
    false,
  );
  assert.deepEqual(learningTools(on, { nativeReady: true, senderFacing: true }), []);
});

test("a start compiles mode auto and the tool only while an agent learns", () => {
  const off = compile([agent("a1"), agent("a2", { skillLearning: false })]);
  assert.deepEqual(off.skills.workshop, { autonomous: { mode: "off" } });
  assert.equal(off.tools.allow.includes(learningTool), false);
  assert.equal(JSON.stringify(off).includes(learningTool), false);

  const on = compile([agent("a1", { skillLearning: true }), agent("a2")]);
  assert.deepEqual(on.skills.workshop, { autonomous: { mode: "auto" } });
  // The global list is every agent's upper bound; nothing else joins it.
  assert.deepEqual(on.tools.allow, [...off.tools.allow, learningTool]);
  assert.ok(on.agents.entries["ap-a1"].tools.allow.includes(learningTool));
  assert.equal(on.agents.entries["ap-a2"].tools.allow.includes(learningTool), false);
  assert.deepEqual(on.agents.entries.main.tools.allow, ["session_status"]);
  assert.deepEqual(on.agents.entries["ap-a2"], off.agents.entries["ap-a2"]);

  // An archived learner and a user agent with a stored "on" leave the mode off.
  const none = compile([
    agent("a1", { skillLearning: true, archivedAt: "2026-11-01T00:00:00Z" }),
    agent("a2", { skillLearning: true, userAccess }),
  ]);
  assert.equal(none.skills.workshop.autonomous.mode, "off");
  assert.equal(JSON.stringify(none).includes(learningTool), false);
});

test("the owner's overrides still cannot reach skills.workshop", () => {
  assert.equal(isLockedPath("skills.workshop"), true);
  assert.equal(isLockedPath("skills.workshop.autonomous.mode"), true);
});

const running = (profiles) => compile(profiles);
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

test("a live apply switches the tool and the mode with the agent's entry", () => {
  const config = running([agent("a1"), agent("a2")]);
  const desired = desiredState({ profiles: [agent("a1", { skillLearning: true })] })
    .agents[0];
  const on = agentPatch(config, desired, state({ learningGlobal: true }));
  assert.ok(on.patch.agents.entries["ap-a1"].tools.allow.includes(learningTool));
  assert.deepEqual(on.patch.tools.allow, [...config.tools.allow, learningTool]);
  assert.deepEqual(on.patch.skills, { workshop: { autonomous: { mode: "auto" } } });
  assert.ok(on.replacePaths.includes("tools.allow"));

  // Back off: the last learner stops, so the tool and the mode go.
  const live = running([agent("a1", { skillLearning: true }), agent("a2")]);
  const stopped = desiredState({ profiles: [agent("a1", { skillLearning: false })] })
    .agents[0];
  const off = agentPatch(live, stopped, state({ learningGlobal: false }));
  assert.equal(
    off.patch.agents.entries["ap-a1"].tools.allow.includes(learningTool),
    false,
  );
  assert.deepEqual(off.patch.tools.allow, config.tools.allow);
  assert.deepEqual(off.patch.skills, { workshop: { autonomous: { mode: "off" } } });

  // Another agent still learns: the host keeps both.
  const kept = agentPatch(live, stopped, state({ learningGlobal: true }));
  assert.equal(kept.patch.tools, undefined);
  assert.equal(kept.patch.skills, undefined);

  // Unmanaged (`learningGlobal` undefined) and unchanged: nothing of the host moves.
  const idle = agentPatch(config, desired, state());
  assert.equal(idle.patch.tools, undefined);
  assert.equal(idle.patch.skills, undefined);
  const same = agentPatch(config, stopped, state({ learningGlobal: false }));
  assert.equal(same.patch.tools, undefined);
  assert.equal(same.patch.skills, undefined);
});

test("a live apply moves the shell tools and the learning tool together", () => {
  const config = running([agent("a1"), agent("a2")]);
  const desired = desiredState({ profiles: [agent("a1", { skillLearning: true })] })
    .agents[0];
  const both = agentPatch(
    config,
    desired,
    state({ learningGlobal: true, shellGlobal: true }),
  );
  assert.deepEqual(both.patch.tools.allow, [
    ...config.tools.allow,
    "exec",
    "process",
    learningTool,
  ]);
});

test("the readback notices a host that does not hold what the apply wrote", () => {
  const profile = agent("a1", { skillLearning: true });
  const config = running([profile]);
  const desired = desiredState({ profiles: [profile] }).agents[0];
  const expected = {
    managed: true,
    tools: config.agents.entries["ap-a1"].tools.allow,
    skills: [],
    shellGlobal: false,
    learningGlobal: true,
  };
  assert.equal(agentDrift(config, desired, expected), false);
  const noTool = structuredClone(config);
  noTool.tools.allow = noTool.tools.allow.filter((tool) => tool !== learningTool);
  assert.equal(agentDrift(noTool, desired, expected), true);
  const noMode = structuredClone(config);
  noMode.skills.workshop.autonomous.mode = "off";
  assert.equal(agentDrift(noMode, desired, expected), true);
  assert.equal(agentDrift(config, desired, { ...expected, learningGlobal: false }), true);
  // Not managed: the host's learning state is not compared.
  const { learningGlobal: _unmanaged, ...unmanaged } = expected;
  assert.equal(agentDrift(noMode, desired, unmanaged), false);
});

test("only this runtime's agents switch the Gateway's review mode", () => {
  const compiler = compilerFor(null);
  // An agent of the runtime whose agents learn by default never counts here.
  const elsewhere = agent("h1", { runtime: RUNTIME_IDS[1] });
  assert.equal(compiler.hostLearns([agent("a1"), elsewhere]), false);
  assert.equal(compiler.hostLearns([agent("a1", { skillLearning: true })]), true);
  assert.equal(
    compiler.hostLearns([agent("a1", { runtime: RUNTIME_IDS[0], skillLearning: true })]),
    true,
  );
  assert.deepEqual(
    compiler.learningTools(agent("a1", { skillLearning: true }), { nativeReady: true }),
    [learningTool],
  );
});

// One skills.status entry of a learned skill as OpenClaw 2026.10.9 builds it
// (dist/status-*.mjs buildSkillStatus, workspace-skill-sources: the root
// `<agentDir>/workshop-skills` with the source "openclaw-workshop", never blocked by
// the agent's skill list).
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const reported = (name, source, extra = {}) => ({
  name,
  description: `${name} skill`,
  source,
  bundled: source === "openclaw-bundled",
  filePath: `/state/agents/ap-a1/agent/workshop-skills/${name}/SKILL.md`,
  baseDir: `/state/agents/ap-a1/agent/workshop-skills/${name}`,
  disabled: false,
  blockedByAgentFilter: source !== "openclaw-workshop",
  eligible: true,
  requirements: { ...none },
  missing: { ...none },
  ...extra,
});

test("the skills port reports a learned skill as one the agent wrote itself", async () => {
  const report = {
    workspaceDir: "/w",
    skills: [
      reported("weather", "openclaw-bundled"),
      reported("deploy-staging", "openclaw-workshop"),
    ],
  };
  const calls = [];
  const client = {
    call: async (method, params) => {
      calls.push([method, params]);
      return structuredClone(report);
    },
  };
  const skills = openClawSkills({ client, status: () => ({ version: "2026.10.9" }) });
  const answer = await skills.status({ agentId: "ap-a1" });
  assert.deepEqual(calls, [["skills.status", { agentId: "ap-a1" }]]);
  // Only the learned skill gains the port's normalized origin; the rest is OpenClaw's.
  assert.deepEqual(answer.skills[0], report.skills[0]);
  assert.deepEqual(answer.skills[1], { ...report.skills[1], origin: "local" });
  assert.equal(answer.workspaceDir, "/w");
  // An answer without a list passes through.
  client.call = async () => ({ fallback: true });
  assert.deepEqual(await skills.status(), { fallback: true });

  // The agent's skills page lists it as on, without a switch, beside the bundled ones
  // (whose names still come from the installation, not from this report).
  const page = skillCatalog({
    report: answer,
    bundled: new Set(["weather", "github"]),
    assistant: agent("a1", { skills: ["weather"] }),
  });
  const byName = Object.fromEntries(page.skills.map((skill) => [skill.name, skill]));
  assert.deepEqual(Object.keys(byName), ["deploy-staging", "github", "weather"]);
  assert.equal(byName["deploy-staging"].state, "selfWritten");
  assert.equal(byName["deploy-staging"].active, true);
  assert.equal(byName["deploy-staging"].assigned, false);
  assert.equal(byName.weather.state, "ready");
  assert.equal(byName.github.state, "unavailable");
  // It cannot be assigned or switched off through AgentPier's list.
  assert.equal(JSON.stringify(byName["deploy-staging"]).includes("/state/"), false);
});

test("a live MCP apply keeps the learning tool in the global list a start writes", () => {
  const profiles = [agent("a1", { skillLearning: true }), agent("a2")];
  const started = compile(profiles);
  const compiler = compilerFor(null);
  // The start's web tools, as McpChanges hands them over (runtime.webTools).
  const web = started.tools.allow.filter(
    (tool) => !nativeTools.includes(tool) && tool !== learningTool,
  );
  const live = (learning) =>
    compiler
      .mcpLive({
        desired: desiredState({ profiles }),
        webTools: { tools: web },
        learning,
      })
      .build(started);
  assert.ok(started.tools.allow.includes(learningTool));
  assert.deepEqual(
    live(compiler.hostLearns(profiles)).patch.tools.allow,
    started.tools.allow,
  );
  // Nobody learns (also: not told): the list a start writes without the tool.
  const off = compile([agent("a1"), agent("a2")]);
  assert.deepEqual(live(false).patch.tools.allow, off.tools.allow);
  assert.deepEqual(live(undefined).patch.tools.allow, off.tools.allow);
});
