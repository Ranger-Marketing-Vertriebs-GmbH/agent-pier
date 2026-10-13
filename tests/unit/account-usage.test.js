import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeUsage,
  usageSources,
} from "../../server/features/accounts/account-usage.js";

const home = {
  id: "home",
  name: "Home",
  model: { connectionId: "router", modelId: "m" },
  capabilities: { webSearch: true },
};
const chat = {
  id: "chat",
  name: "Chat",
  model: { connectionId: `openclaw:${"a".repeat(64)}`, modelId: "gpt" },
  capabilities: {},
};
const member = {
  id: "member",
  name: "Reviewer",
  teamMemberId: "t1",
  lifetime: "task",
  model: { connectionId: "router", modelId: "m" },
  capabilities: { webSearch: true },
};
const sources = {
  agentsEnabled: true,
  connections: [
    {
      id: "router",
      tools: ["claude", "codex"],
      toolRoutes: { claude: { mode: "adapter", source: "x" }, codex: null },
    },
    { id: "unused", tools: ["opencode"] },
  ],
  accounts: [{ id: "local-codex" }, { id: "work" }],
  sessions: [
    {
      accountId: "internal-1",
      access: { providerConnectionId: "router", sourceAccountId: "work" },
    },
    { accountId: "work" },
    { accountId: "local-codex" },
  ],
  profiles: [
    {
      id: "p1",
      name: "Coder",
      config: { accountId: "work", providerConnectionId: "router" },
    },
  ],
  servers: [
    { id: "github", clis: ["codex"] },
    { id: "idle", clis: [] },
  ],
  agents: [home, chat, member],
  access: { home: { connectionIds: ["router"], accountIds: ["work"] } },
  agentServers: { home: ["github"], chat: ["github", "deleted"] },
  channels: [{ assistantId: "chat" }],
};

test("usage names agents, sessions, profiles and CLI routes per entry", () => {
  const usage = summarizeUsage(sources);
  assert.deepEqual(usage.connections.router, {
    agents: [
      { id: "home", name: "Home", kind: "agent", via: "model" },
      { id: "home", name: "Home", kind: "agent", via: "pipelines" },
      { id: "member", name: "Reviewer", kind: "teamMember", via: "model" },
    ],
    sessions: 1,
    pipelineProfiles: [{ id: "p1", name: "Coder" }],
    clis: [
      { tool: "claude", route: { mode: "adapter", source: "x" } },
      { tool: "codex", route: null },
    ],
  });
  assert.deepEqual(usage.connections.unused, {
    agents: [],
    sessions: 0,
    pipelineProfiles: [],
    clis: [{ tool: "opencode", route: null }],
  });
  assert.deepEqual(usage.chatgpt[chat.model.connectionId].agents, [
    { id: "chat", name: "Chat", kind: "agent", via: "model" },
  ]);
  assert.equal(usage.cliAccounts.work.sessions, 2);
  assert.equal(usage.cliAccounts["local-codex"].sessions, 1);
  assert.deepEqual(usage.cliAccounts.work.pipelineProfiles, [
    { id: "p1", name: "Coder" },
  ]);
  assert.deepEqual(usage.cliAccounts.work.agents, [
    { id: "home", name: "Home", kind: "agent", via: "pipelines" },
  ]);
  assert.deepEqual(
    usage.mcpServers.github.agents.map((a) => a.id),
    ["home", "chat"],
  );
  assert.deepEqual(usage.mcpServers.github.clis, [{ tool: "codex", route: null }]);
  assert.deepEqual(usage.mcpServers.idle.agents, []);
  assert.deepEqual(
    usage.webSearch.agents.map((a) => a.id),
    ["home"],
  );
  assert.deepEqual(usage.speech.agents, [
    { id: "chat", name: "Chat", kind: "agent", via: "channel" },
  ]);
});

test("without agents the usage lists only sessions, profiles and CLIs", () => {
  const usage = summarizeUsage({
    ...sources,
    agentsEnabled: false,
    agents: [],
    access: {},
    agentServers: {},
    channels: [],
  });
  assert.equal(usage.agentsEnabled, false);
  assert.equal(usage.webSearch, null);
  assert.equal(usage.speech, null);
  assert.deepEqual(usage.chatgpt, {});
  assert.deepEqual(usage.connections.router.agents, []);
  assert.equal(usage.connections.router.sessions, 1);
});

test("sources that failed to read are null, never a fake 0", () => {
  const usage = summarizeUsage({
    ...sources,
    agentsKnown: false,
    sessions: null,
    profiles: null,
  });
  for (const entry of [
    usage.connections.router,
    usage.cliAccounts.work,
    usage.mcpServers.github,
    usage.webSearch,
    usage.speech,
  ]) {
    assert.equal(entry.agents, null);
    assert.equal(entry.sessions, null);
    assert.equal(entry.pipelineProfiles, null);
  }
  assert.deepEqual(
    usage.connections.router.clis.map((c) => c.tool),
    ["claude", "codex"],
  );
});

test("a failing read marks its source unknown", async () => {
  const fail = () => {
    throw new Error("unreadable");
  };
  const sourcesRead = await usageSources({
    assistantFeature: { enabled: true },
    assistants: {
      store: { listAssistants: () => [home] },
      workflows: { access: { get: fail } },
    },
    providerConnections: { list: () => [{ id: "router", tools: [] }] },
    accounts: { list: fail },
    sessions: { list: async () => fail() },
    pipelineDefinitions: { listProfiles: fail },
    mcpServers: { list: () => [], bindings: () => [] },
    assistantChannels: { store: { list: () => [] } },
  });
  assert.equal(sourcesRead.agentsKnown, false);
  assert.equal(sourcesRead.sessions, null);
  assert.equal(sourcesRead.profiles, null);
  assert.deepEqual(sourcesRead.accounts, []);
  const usage = summarizeUsage(sourcesRead);
  assert.equal(usage.connections.router.sessions, null);
  assert.equal(usage.connections.router.agents, null);
});
