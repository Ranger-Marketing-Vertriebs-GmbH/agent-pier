import test from "node:test";
import assert from "node:assert/strict";
import {
  agentRoute,
  capabilityPatch,
  capabilityServer,
  channelActivity,
  channelPatch,
  createInput,
  createServer,
  grantCount,
  heartbeatPatch,
  invalidTeamKeys,
  pendingCount,
  profilePatch,
  profileServer,
  removedProjectCount,
  resolveAgentLocation,
  staysOnAgentTab,
  telegramServer,
  toggleId,
  visibleAgentTabs,
  workBody,
  workServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";

const agent = (extra = {}) => ({
  id: "home",
  name: "Home",
  instructions: "Plan meals",
  revision: 3,
  model: { connectionId: "router", modelId: "model" },
  capabilities: { memory: true, reminders: false },
  mcpServers: ["b", "a"],
  ...extra,
});
const settings = (extra = {}) => ({
  view: "agents",
  assistantId: "home",
  agentSettings: true,
  ...extra,
});

test("personal agents get four tabs, task-bound members two", () => {
  assert.deepEqual(visibleAgentTabs(agent()), [
    "profile",
    "capabilities",
    "work",
    "telegram",
  ]);
  assert.deepEqual(
    visibleAgentTabs(agent({ teamMemberId: "m", lifetime: "permanent" })),
    ["profile", "capabilities", "work", "telegram"],
  );
  assert.deepEqual(visibleAgentTabs(agent({ teamMemberId: "m", lifetime: "task" })), [
    "profile",
    "capabilities",
  ]);
});

test("locations the agent cannot show normalise to a valid tab", () => {
  assert.deepEqual(resolveAgentLocation(agent(), settings({ agentTab: "work" })), {
    tab: "work",
    page: "",
    tabs: ["profile", "capabilities", "work", "telegram"],
    normalized: false,
  });
  const member = agent({ teamMemberId: "m", lifetime: "task" });
  const hidden = resolveAgentLocation(member, settings({ agentTab: "telegram" }));
  assert.equal(hidden.tab, "profile");
  assert.equal(hidden.normalized, true);
  const noMemory = agent({ capabilities: { memory: false } });
  const memory = resolveAgentLocation(
    noMemory,
    settings({ agentTab: "capabilities", agentPage: "memory" }),
  );
  assert.deepEqual(
    [memory.tab, memory.page, memory.normalized],
    ["capabilities", "", true],
  );
  const archived = agent({ archivedAt: "2026-10-01" });
  const allowlist = resolveAgentLocation(
    archived,
    settings({ agentTab: "capabilities", agentPage: "allowlist" }),
  );
  assert.equal(allowlist.page, "");
});

test("agent routes leave the default tab out and carry a subpage's tab", () => {
  assert.deepEqual(agentRoute("home"), settings());
  assert.deepEqual(agentRoute("home", "work"), settings({ agentTab: "work" }));
  assert.deepEqual(
    agentRoute("home", "capabilities", "memory"),
    settings({ agentTab: "capabilities", agentPage: "memory" }),
  );
});

test("a draft stays only for navigations within its own tab", () => {
  const stays = staysOnAgentTab("home", "work");
  assert.equal(
    stays({ next: settings({ agentTab: "work", agentPage: "projects" }) }),
    true,
  );
  assert.equal(stays({ next: settings({ agentTab: "telegram" }) }), false);
  assert.equal(
    stays({ next: { ...settings({ agentTab: "work" }), assistantId: "other" } }),
    false,
  );
  assert.equal(
    stays({ next: { view: "agents", assistantId: "home", conversationId: "c" } }),
    false,
  );
  assert.equal(stays({}), false);
  const memory = staysOnAgentTab("home", "capabilities", "memory");
  assert.equal(
    memory({ next: settings({ agentTab: "capabilities", agentPage: "memory" }) }),
    true,
  );
  assert.equal(memory({ next: settings({ agentTab: "capabilities" }) }), false);
});

test("profile drafts send name, instructions and the model together", () => {
  const server = profileServer(agent());
  assert.deepEqual(server, {
    name: "Home",
    instructions: "Plan meals",
    connectionId: "router",
    modelId: "model",
  });
  assert.deepEqual(profilePatch({ ...server, modelId: "other" }), {
    name: "Home",
    instructions: "Plan meals",
    model: { connectionId: "router", modelId: "other" },
  });
  assert.deepEqual(profileServer(undefined), {
    name: "",
    instructions: "",
    connectionId: "",
    modelId: "",
  });
});

test("capability drafts flatten switches and send only what changed", () => {
  const assistant = agent();
  const base = capabilityServer(assistant);
  assert.deepEqual(base, {
    memory: true,
    reminders: false,
    webSearch: false,
    webFetch: false,
    browser: false,
    documents: false,
    browserVisible: false,
    shell: "off",
    mcpServers: ["a", "b"],
    skills: [],
  });
  // The visible browser window is sent on its own, and never for a member.
  assert.deepEqual(
    capabilityPatch({ values: { ...base, browserVisible: true }, base, assistant }),
    { browserVisible: true },
  );
  assert.deepEqual(
    capabilityPatch({ values: { ...base, webFetch: true }, base, assistant }),
    {
      capabilities: {
        memory: true,
        reminders: false,
        webSearch: false,
        webFetch: true,
        browser: false,
        documents: false,
      },
    },
  );
  assert.deepEqual(
    capabilityPatch({
      values: { ...base, shell: "approval", mcpServers: ["a"] },
      base,
      assistant,
    }),
    { shell: "approval", mcpServers: ["a"] },
  );
  // Skills are sent sorted, and only when they changed.
  assert.deepEqual(
    capabilityServer(agent({ skills: ["weather", "github", "weather"] })).skills,
    ["github", "weather"],
  );
  assert.deepEqual(
    capabilityPatch({ values: { ...base, skills: ["github"] }, base, assistant }),
    { skills: ["github"] },
  );
  const member = agent({ teamMemberId: "m", lifetime: "task" });
  assert.deepEqual(
    capabilityPatch({
      values: { ...base, shell: "full", skills: ["github"], browserVisible: true },
      base,
      assistant: member,
    }),
    {},
  );
});

test("switching memory off also switches a saved check-in schedule off", () => {
  const assistant = agent({
    heartbeat: { enabled: true, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
  });
  const base = capabilityServer(assistant);
  assert.deepEqual(
    capabilityPatch({ values: { ...base, memory: false }, base, assistant }),
    {
      capabilities: {
        memory: false,
        reminders: false,
        webSearch: false,
        webFetch: false,
        browser: false,
        documents: false,
      },
      heartbeat: { enabled: false, interval: "4h", start: 9, end: 18, timeZone: "UTC" },
    },
  );
});

test("telegram drafts keep the heartbeat flat and send only changed channel fields", () => {
  const assistant = agent({
    heartbeat: { enabled: true, interval: "2h", start: 8, end: 20, timeZone: "UTC" },
  });
  const base = telegramServer(assistant, { language: "en", appUrl: null });
  assert.deepEqual(base, {
    heartbeatEnabled: true,
    interval: "2h",
    start: 8,
    end: 20,
    timeZone: "UTC",
    language: "en",
    appUrl: "",
  });
  assert.deepEqual(heartbeatPatch({ ...base, interval: "1h" }, assistant), {
    heartbeat: { enabled: true, interval: "1h", start: 8, end: 20, timeZone: "UTC" },
  });
  const noMemory = { ...assistant, capabilities: { memory: false } };
  assert.equal(heartbeatPatch(base, noMemory).heartbeat.enabled, false);
  // Without a paired chat the server refuses switching check-ins on: never sent.
  const unpaired = { ...assistant, heartbeatChannel: false };
  assert.equal(heartbeatPatch(base, unpaired).heartbeat.enabled, false);
  const paired = { ...assistant, heartbeatChannel: true };
  assert.equal(heartbeatPatch(base, paired).heartbeat.enabled, true);
  assert.deepEqual(channelPatch({ values: { ...base, language: "de" }, base }), {
    language: "de",
  });
  assert.deepEqual(channelPatch({ values: { ...base, appUrl: "  " }, base }), {
    appUrl: null,
  });
  assert.equal(telegramServer(assistant, null).language, "de");
});

test("work drafts send only the half that changed, each with its revision", () => {
  const base = workServer(
    { revision: 4, projectIds: ["p2", "p1"], pipelineIds: [], memoryWrite: true },
    { revision: 7, autonomous: false, maxMembers: 4, runTimeoutMinutes: 30 },
  );
  assert.deepEqual(base, {
    projectIds: ["p1", "p2"],
    projectFiles: {},
    pipelineIds: [],
    sshAccesses: [],
    github: null,
    memoryWrite: true,
    autonomous: false,
    publish: false,
    teamAutonomous: false,
    memberShellSsh: false,
    maxMembers: 4,
    runTimeoutMinutes: 30,
  });
  const revisions = { access: 4, team: 7 };
  assert.deepEqual(
    workBody({
      values: { ...base, maxMembers: 6 },
      changed: ["maxMembers"],
      revisions,
      withTeam: true,
    }),
    {
      team: {
        revision: 7,
        autonomous: false,
        memberShellSsh: false,
        maxMembers: 6,
        runTimeoutMinutes: 30,
      },
    },
  );
  // The member shell and SSH setting is part of the team half.
  assert.deepEqual(
    workBody({
      values: { ...base, memberShellSsh: true },
      changed: ["memberShellSsh"],
      revisions,
      withTeam: true,
    }).team.memberShellSsh,
    true,
  );
  assert.deepEqual(
    workBody({
      values: { ...base, publish: true },
      changed: ["publish"],
      revisions,
      withTeam: false,
    }),
    {
      access: {
        revision: 4,
        projectIds: ["p1", "p2"],
        pipelineIds: [],
        memoryWrite: true,
        autonomous: false,
        publish: true,
      },
    },
  );
  assert.deepEqual(workServer(null, null).maxMembers, "");
});

test("team numbers must be whole numbers within the server's limits", () => {
  assert.deepEqual(invalidTeamKeys({ maxMembers: 4, runTimeoutMinutes: 30 }), []);
  assert.deepEqual(invalidTeamKeys({ maxMembers: 1, runTimeoutMinutes: 60 }), []);
  assert.deepEqual(invalidTeamKeys({ maxMembers: 8, runTimeoutMinutes: 1 }), []);
  for (const bad of ["", 0, 9, 1.5, null, undefined])
    assert.deepEqual(invalidTeamKeys({ maxMembers: bad, runTimeoutMinutes: 30 }), [
      "maxMembers",
    ]);
  for (const bad of ["", 0, 61, 2.5])
    assert.deepEqual(invalidTeamKeys({ maxMembers: 4, runTimeoutMinutes: bad }), [
      "runTimeoutMinutes",
    ]);
});

test("counts never invent numbers", () => {
  assert.equal(grantCount(["p1", "gone"], [{ id: "p1" }, { id: "p2" }]), 1);
  assert.equal(pendingCount([{ state: "awaiting_approval" }, { state: "running" }]), 1);
  assert.deepEqual(toggleId(["b"], "a", true), ["a", "b"]);
  assert.deepEqual(toggleId(["a", "b"], "a", false), ["b"]);
});

test("a saved Work draft reports the projects the server dropped", () => {
  const saved = (work) => ({ status: "saved", results: { work } });
  assert.equal(removedProjectCount(saved({ removedProjectIds: ["gone", "old"] })), 2);
  assert.equal(removedProjectCount(saved({ removedProjectIds: [] })), 0);
  assert.equal(removedProjectCount(saved(undefined)), 0);
  assert.equal(removedProjectCount({ status: "conflict" }), 0);
});

test("Telegram activity keeps entries that need a decision ahead of the recent ones", () => {
  const channel = {
    inputs: [
      { id: "old", state: "delivery_failed" },
      ...Array.from({ length: 25 }, (_, i) => ({ id: `i${i}`, state: "delivered" })),
    ],
    notifications: [{ id: "n", state: "delivered", needsReview: true }],
  };
  const activity = channelActivity(channel);
  assert.equal(activity.attention, 2);
  assert.equal(activity.visible[0].id, "old");
  assert.equal(activity.visible.length, 21);
  assert.deepEqual(channelActivity(null), { entries: [], visible: [], attention: 0 });
});

test("create mode starts empty and sends shell only when raised", () => {
  const values = { ...createServer(), name: "Fresh", memory: true };
  assert.deepEqual(createInput(values), {
    name: "Fresh",
    instructions: "",
    model: { connectionId: "", modelId: "" },
    capabilities: {
      memory: true,
      reminders: false,
      webSearch: false,
      webFetch: false,
      browser: false,
      documents: false,
    },
  });
  assert.equal(createInput({ ...values, shell: "approval" }).shell, "approval");
});
