import test from "node:test";
import assert from "node:assert/strict";
import {
  memberOptionsOf,
  restrictRuntimeOptions,
  runtimeOptionsOf,
  validateRuntimeOptions,
} from "../../server/features/assistants/runtimes/runtime-options.js";
import { thinkingLevels } from "../../server/features/assistants/runtimes/openclaw/openclaw-options.js";
import { advancedSetting } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/advanced-settings.js";
import {
  desiredAgent,
  desiredState,
} from "../../server/features/assistants/agent-desired-state.js";
import { compilerFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import {
  agentEntry,
  loopProtection,
  modelDefaults,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-entry.js";
import {
  agentDrift,
  agentPatch,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-apply.js";
import { AssistantModels } from "../../server/features/assistants/assistant-models.js";
import { settingsPatch } from "../../server/features/users/user-agent-settings.js";
import { goldenPaths, goldenScenarios } from "../helpers/openclaw-golden-scenarios.js";

// How an OpenClaw agent's model works, per agent (`runtimeOptions.openclaw.thinking`
// and `.fastMode`): stored only when set, compiled into the agent's entry as
// OpenClaw's `thinkingDefault` and `fastModeDefault`, removed again by a live apply,
// and taken over by a temporary team member from its lead.

const options = (value) => ({ openclaw: value });
const agent = (id, extra = {}) => ({
  id,
  name: `Agent ${id}`,
  runtimeAgentId: `ap-${id}`,
  revision: 1,
  model: { connectionId: "c", modelId: "m" },
  capabilities: { memory: true },
  ...extra,
});
const withOptions = (id, value, extra = {}) =>
  agent(id, { runtimeOptions: options(value), ...extra });
const member = (id, extra = {}) =>
  agent(id, {
    teamMemberId: `tm-${id}`,
    lifetime: "task",
    parentAssistantId: "lead",
    inherited: { capabilities: {}, skills: [], shell: "off", ssh: false },
    ...extra,
  });
const users = { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] };
const shared = { ...users, mode: "shared" };
const refused = (fn, key, status) =>
  assert.throws(fn, (error) => error.key === key && error.status === status, key);

test("the levels are the ones OpenClaw's own default setting accepts", () => {
  assert.deepEqual(
    [...thinkingLevels],
    advancedSetting("agents.defaults.thinkingDefault").schema.enum,
  );
});

test("a thinking level and fast mode are stored as given; unset stores nothing", () => {
  const own = agent("a1");
  for (const level of thinkingLevels)
    assert.deepEqual(validateRuntimeOptions(own, options({ thinking: level })), {
      openclaw: { thinking: level },
    });
  // Off is a choice of its own, unlike a switch that is merely not on.
  assert.deepEqual(
    validateRuntimeOptions(own, options({ thinking: "off", fastMode: false })),
    { openclaw: { thinking: "off", fastMode: false } },
  );
  assert.deepEqual(validateRuntimeOptions(own, options({ fastMode: true })), {
    openclaw: { fastMode: true },
  });
  assert.deepEqual(validateRuntimeOptions(own, options({})), {});
  // Beside the wiki, in one object.
  assert.deepEqual(
    validateRuntimeOptions(own, options({ memoryWiki: true, thinking: "high" })),
    { openclaw: { memoryWiki: true, thinking: "high" } },
  );
  assert.deepEqual(
    validateRuntimeOptions(own, options({ memoryWiki: false, thinking: "high" })),
    { openclaw: { thinking: "high" } },
  );
});

test("a value OpenClaw does not name is refused", () => {
  const own = agent("a1");
  for (const value of [
    { thinking: "extreme" },
    { thinking: "" },
    { thinking: null },
    { thinking: true },
    { thinking: "toString" },
    { fastMode: "on" },
    { fastMode: "auto" },
    { fastMode: null },
    { fastMode: 1 },
  ])
    refused(() => validateRuntimeOptions(own, options(value)), "optionsInvalid", 400);
  refused(
    () => validateRuntimeOptions(own, options({ reasoning: "high" })),
    "optionsUnknownKey",
    400,
  );
  // A Hermes agent has neither option.
  refused(
    () =>
      validateRuntimeOptions(agent("h1", { runtime: "hermes" }), {
        hermes: { thinking: "high" },
      }),
    "optionsUnknownKey",
    400,
  );
});

test("the owner sets them for a shared agent and a user's agent; users never do", () => {
  for (const userAccess of [shared, users]) {
    const served = agent("u1", { userAccess });
    assert.deepEqual(
      validateRuntimeOptions(served, options({ thinking: "low", fastMode: true })),
      { openclaw: { thinking: "low", fastMode: true } },
    );
    const stored = { ...served, runtimeOptions: options({ thinking: "low" }) };
    assert.deepEqual(runtimeOptionsOf(stored), { thinking: "low" });
    // Becoming a users' agent drops the wiki and keeps how the model works.
    assert.deepEqual(
      restrictRuntimeOptions({
        ...served,
        runtimeOptions: options({ memoryWiki: true, thinking: "low" }),
      }).runtimeOptions,
      options({ thinking: "low" }),
    );
  }
  refused(
    () =>
      settingsPatch(agent("u1", { userAccess: users }), "extended", {
        runtimeOptions: options({ thinking: "max" }),
      }),
    "invalid",
    400,
  );
});

test("a temporary member stores none and works with its lead's", () => {
  const lead = withOptions("lead", {
    memoryWiki: true,
    thinking: "high",
    fastMode: false,
  });
  const task = member("m1");
  refused(
    () => validateRuntimeOptions(task, options({ thinking: "low" })),
    "modelOptionsTaskMember",
    409,
  );
  refused(
    () => validateRuntimeOptions(task, options({ fastMode: true })),
    "modelOptionsTaskMember",
    409,
  );
  // A stored value (a member made temporary again, an older file) is never read.
  const stale = member("m1", { runtimeOptions: options({ thinking: "low" }) });
  assert.deepEqual(runtimeOptionsOf(stale), {});
  // How the model works comes from the lead; the wiki stays the lead's alone.
  assert.deepEqual(memberOptionsOf(stale, lead), { thinking: "high", fastMode: false });
  assert.ok(Object.isFrozen(memberOptionsOf(stale, lead)));
  assert.deepEqual(memberOptionsOf(task, agent("lead")), {});
  assert.deepEqual(memberOptionsOf(task, null), {});
  // Never across runtimes.
  assert.deepEqual(
    memberOptionsOf(member("m1", { runtime: "hermes" }), lead),
    runtimeOptionsOf(member("m1", { runtime: "hermes" })),
  );
  assert.deepEqual(desiredAgent(task, { lead }).runtimeOptions, {
    thinking: "high",
    fastMode: false,
  });
  assert.deepEqual(desiredAgent(task).runtimeOptions, {});
  // A permanent member is an agent of its own: its own options, never its lead's.
  const permanent = member("p1", {
    lifetime: "permanent",
    runtimeOptions: options({ thinking: "minimal" }),
  });
  assert.deepEqual(desiredAgent(permanent, { lead }).runtimeOptions, {
    thinking: "minimal",
  });
  // A whole desired state finds each member's lead itself.
  const state = desiredState({ profiles: [lead, task, permanent] });
  assert.deepEqual(
    state.agents.map((a) => a.runtimeOptions),
    [
      { memoryWiki: true, thinking: "high", fastMode: false },
      { thinking: "high", fastMode: false },
      { thinking: "minimal" },
    ],
  );
});

const ready = { teamsReady: true, nativeReady: true, guardProven: true };

test("the agent's entry holds OpenClaw's two defaults, and only what is set", () => {
  assert.deepEqual(
    modelDefaults(withOptions("a1", { thinking: "xhigh", fastMode: true })),
    {
      thinkingDefault: "xhigh",
      fastModeDefault: true,
    },
  );
  assert.deepEqual(modelDefaults(withOptions("a1", { fastMode: false })), {
    fastModeDefault: false,
  });
  assert.deepEqual(modelDefaults(agent("a1")), {});
  const entry = agentEntry(
    { id: "ap-a1", model: "m", thinkingDefault: "low", fastModeDefault: true },
    withOptions("a1", { thinking: "off" }),
    ready,
  );
  assert.equal(entry.thinkingDefault, "off");
  assert.equal("fastModeDefault" in entry, false);
  assert.equal(entry.model, "m");
  // While AgentPier does not manage the entry's tools it leaves these alone, too.
  const unmanaged = agentEntry(
    { id: "ap-a1", thinkingDefault: "low" },
    withOptions("a1", { thinking: "off" }),
    { teamsReady: false, nativeReady: false },
  );
  assert.equal(unmanaged.thinkingDefault, "low");
});

const compile = (profiles, entries = {}) => {
  const scenario = goldenScenarios["no-tools"]();
  return compilerFor(null).compile({
    desired: desiredState({ ...scenario.teams, profiles }),
    existing: {
      agents: {
        defaults: {},
        entries: Object.fromEntries([
          ["main", {}],
          ...profiles.map((p) => [p.runtimeAgentId, entries[p.runtimeAgentId] || {}]),
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

test("a start compiles each agent's own values and a member's lead's", () => {
  const lead = withOptions("lead", { thinking: "high", fastMode: true });
  const config = compile([lead, member("m1"), agent("a2")], {
    // What an earlier start or apply wrote for an agent that sets none any more.
    "ap-a2": { thinkingDefault: "max", fastModeDefault: false },
  });
  const entries = config.agents.entries;
  assert.equal(entries["ap-lead"].thinkingDefault, "high");
  assert.equal(entries["ap-lead"].fastModeDefault, true);
  assert.equal(entries["ap-m1"].thinkingDefault, "high");
  assert.equal(entries["ap-m1"].fastModeDefault, true);
  assert.equal("thinkingDefault" in entries["ap-a2"], false);
  assert.equal("fastModeDefault" in entries["ap-a2"], false);
  // The owner's default for all agents is another path, untouched.
  assert.equal(config.agents.defaults.thinkingDefault, undefined);
  assert.equal("thinkingDefault" in entries.main, false);
});

const state = () => ({
  ...ready,
  toolsManaged: true,
  memoryManaged: true,
  managed: true,
  shellGlobal: false,
});

test("a live apply writes a set value and removes one that was unset", () => {
  const before = withOptions("a1", { thinking: "high", fastMode: true });
  const config = compile([before]);
  const only = (profile) =>
    agentPatch(config, desiredState({ profiles: [profile] }).agents[0], state).patch
      .agents.entries["ap-a1"];
  const changed = only(withOptions("a1", { thinking: "low", fastMode: true }));
  assert.equal(changed.thinkingDefault, "low");
  assert.equal(changed.fastModeDefault, true);
  // A merge patch keeps an omitted key: null removes it.
  const cleared = only(withOptions("a1", { fastMode: false }));
  assert.equal(cleared.thinkingDefault, null);
  assert.equal(cleared.fastModeDefault, false);
  const none = only(agent("a1"));
  assert.equal(none.thinkingDefault, null);
  assert.equal(none.fastModeDefault, null);
  // Nothing to remove where nothing was written.
  const plain = compile([agent("a1")]);
  const untouched = agentPatch(
    plain,
    desiredState({ profiles: [agent("a1")] }).agents[0],
    state,
  ).patch.agents.entries["ap-a1"];
  assert.equal("thinkingDefault" in untouched, false);
  assert.equal("fastModeDefault" in untouched, false);
});

test("the readback notices an entry that holds another level or mode", () => {
  const profile = withOptions("a1", { thinking: "high" });
  const config = compile([profile]);
  const desired = desiredState({ profiles: [profile] }).agents[0];
  const expected = {
    managed: true,
    tools: config.agents.entries["ap-a1"].tools.allow,
    skills: [],
    shellGlobal: false,
  };
  assert.equal(agentDrift(config, desired, expected), false);
  const other = (change) => {
    const next = structuredClone(config);
    change(next.agents.entries["ap-a1"]);
    return agentDrift(next, desired, expected);
  };
  assert.equal(
    other((entry) => (entry.thinkingDefault = "low")),
    true,
  );
  assert.equal(
    other((entry) => delete entry.thinkingDefault),
    true,
  );
  assert.equal(
    other((entry) => (entry.fastModeDefault = true)),
    true,
  );
  // Unmanaged, the entry is not AgentPier's to judge.
  const loose = structuredClone(config);
  loose.agents.entries["ap-a1"].thinkingDefault = "low";
  assert.equal(
    agentDrift(loose, desired, { shellGlobal: undefined, managed: false }),
    false,
  );
});

// Loop protection (`runtimeOptions.openclaw.loopDetection`): OpenClaw's rolling loop
// detectors for one agent. Unset is automatic, on for a model of an endpoint
// connection; it reaches OpenClaw only as `enabled: true`, never as `false`.

const live = (profile, kind, extra = {}) =>
  desiredAgent(profile, {
    model: { ref: "ap-c/m", providerId: "ap-c", kind },
    ...extra,
  });
const loopOf = (entry) => entry.tools?.loopDetection;

test("loop protection is the owner's choice, stored in both directions", () => {
  const own = agent("a1");
  for (const value of [true, false])
    assert.deepEqual(validateRuntimeOptions(own, options({ loopDetection: value })), {
      openclaw: { loopDetection: value },
    });
  for (const value of ["on", "auto", null, 1])
    refused(
      () => validateRuntimeOptions(own, options({ loopDetection: value })),
      "optionsInvalid",
      400,
    );
  assert.deepEqual(runtimeOptionsOf(withOptions("a1", { loopDetection: false })), {
    loopDetection: false,
  });
  assert.deepEqual(runtimeOptionsOf(withOptions("a1", { loopDetection: "yes" })), {});
  // A temporary member stores none and takes over its lead's choice, not its rule.
  refused(
    () => validateRuntimeOptions(member("m1"), options({ loopDetection: true })),
    "modelOptionsTaskMember",
    409,
  );
  assert.deepEqual(
    memberOptionsOf(member("m1"), withOptions("lead", { loopDetection: false })),
    { loopDetection: false },
  );
  assert.deepEqual(memberOptionsOf(member("m1"), agent("lead")), {});
});

test("without a choice an endpoint model is protected and no other", () => {
  const plain = agent("a1");
  assert.equal(loopProtection(live(plain, "endpoint")), true);
  assert.equal(loopProtection(live(plain, "openrouter")), false);
  // A ChatGPT account's lease names no kind.
  assert.equal(loopProtection(live(plain, undefined)), false);
  // The owner's choice wins in both directions.
  assert.equal(
    loopProtection(live(withOptions("a1", { loopDetection: false }), "endpoint")),
    false,
  );
  assert.equal(
    loopProtection(live(withOptions("a1", { loopDetection: true }), "openrouter")),
    true,
  );
  // A member: its lead's choice, else the rule for the model it runs on itself.
  const chosen = withOptions("lead", { loopDetection: true });
  assert.equal(loopProtection(live(member("m1"), "openrouter", { lead: chosen })), true);
  assert.equal(
    loopProtection(live(member("m1"), "endpoint", { lead: agent("lead") })),
    true,
  );
  assert.equal(
    loopProtection(live(member("m1"), "openrouter", { lead: agent("lead") })),
    false,
  );
  // A start knows no model connection: it keeps what the last apply wrote.
  const written = { tools: { loopDetection: { enabled: true } } };
  assert.equal(loopProtection(plain, written), true);
  assert.equal(loopProtection(plain, {}), false);
  assert.equal(loopProtection(plain, undefined), false);
  assert.equal(
    loopProtection(withOptions("a1", { loopDetection: false }), written),
    false,
  );
  assert.equal(loopProtection(withOptions("a1", { loopDetection: true }), {}), true);
});

test("the entry holds the key beside allow and exec, and never as false", () => {
  const shell = agent("a1", { shell: "approval" });
  const on = agentEntry({ id: "ap-a1" }, live(shell, "endpoint"), ready);
  assert.deepEqual(loopOf(on), { enabled: true });
  assert.ok(on.tools.allow.includes("exec"));
  assert.ok(on.tools.exec);
  for (const desired of [
    live(shell, "openrouter"),
    live(withOptions("a1", { loopDetection: false }), "endpoint"),
  ]) {
    const off = agentEntry(
      { id: "ap-a1", tools: { loopDetection: { enabled: true } } },
      desired,
      ready,
    );
    assert.equal("loopDetection" in off.tools, false);
    assert.doesNotMatch(JSON.stringify(off), /"enabled":false/);
  }
  // No golden or compiled start ever disables OpenClaw's guard after a compaction.
  const config = compile([
    withOptions("a1", { loopDetection: false }),
    withOptions("a2", { loopDetection: true }),
  ]);
  assert.equal(loopOf(config.agents.entries["ap-a1"]), undefined);
  assert.deepEqual(loopOf(config.agents.entries["ap-a2"]), { enabled: true });
  assert.equal(config.tools.loopDetection, undefined);
});

test("a live apply switches protection on and removes it with null", () => {
  const config = compile([withOptions("a1", { loopDetection: true })]);
  const patched = (desired) =>
    agentPatch(config, desired, state).patch.agents.entries["ap-a1"].tools;
  // Chosen off, or back to automatic on a model that needs none: the key goes.
  assert.equal(
    patched(live(withOptions("a1", { loopDetection: false }), "endpoint")).loopDetection,
    null,
  );
  assert.equal(patched(live(agent("a1"), "openrouter")).loopDetection, null);
  assert.deepEqual(patched(live(agent("a1"), "endpoint")).loopDetection, {
    enabled: true,
  });
  // Nothing to remove where nothing was written.
  const plain = compile([agent("a1")]);
  const untouched = agentPatch(plain, live(agent("a1"), "openrouter"), state).patch.agents
    .entries["ap-a1"].tools;
  assert.equal("loopDetection" in untouched, false);
  assert.deepEqual(
    agentPatch(plain, live(agent("a1"), "endpoint"), state).patch.agents.entries["ap-a1"]
      .tools.loopDetection,
    { enabled: true },
  );
});

test("the readback notices protection that is missing or left over", () => {
  const config = compile([agent("a1")]);
  // As the apply's agents.update wrote it: the entry runs on the leased model.
  config.agents.entries["ap-a1"].model = "ap-c/m";
  const expected = {
    managed: true,
    tools: config.agents.entries["ap-a1"].tools.allow,
    skills: [],
    shellGlobal: false,
  };
  const withLoop = structuredClone(config);
  withLoop.agents.entries["ap-a1"].tools.loopDetection = { enabled: true };
  const endpoint = live(agent("a1"), "endpoint");
  const router = live(agent("a1"), "openrouter");
  assert.equal(agentDrift(withLoop, endpoint, expected), false);
  assert.equal(agentDrift(config, endpoint, expected), true);
  assert.equal(agentDrift(config, router, expected), false);
  assert.equal(agentDrift(withLoop, router, expected), true);
  // An explicit false in the file is never what AgentPier wrote.
  const disabled = structuredClone(config);
  disabled.agents.entries["ap-a1"].tools.loopDetection = { enabled: false };
  assert.equal(agentDrift(disabled, router, expected), true);
});

test("the model lease names its connection's kind", () => {
  const connection = { id: "c1", name: "Local", providerId: "openrouter" };
  const models = new AssistantModels({
    connections: {
      get: () => connection,
      acquire: () => () => {},
      secret: () => ({ apiKey: "k" }),
    },
  });
  const lease = models.resolve({ connectionId: "c1", modelId: "a/b" });
  assert.equal(lease.kind, "openrouter");
});
