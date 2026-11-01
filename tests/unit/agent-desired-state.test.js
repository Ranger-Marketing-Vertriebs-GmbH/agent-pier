import test from "node:test";
import assert from "node:assert/strict";
import {
  desiredAgent,
  desiredState,
  isDesiredAgent,
  isDesiredState,
} from "../../server/features/assistants/agent-desired-state.js";
import {
  grantedTools,
  profileTools,
} from "../../server/features/assistants/native-capabilities.js";

const profile = (extra = {}) => ({
  id: "a1",
  name: "Agent",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, browser: true, webFetch: true },
  skills: ["weather"],
  ...extra,
});
const ready = { teamsReady: true, nativeReady: true, writeGuard: true };

test("an agent's desired state names what AgentPier wants of it, frozen", () => {
  const agent = desiredAgent(profile({ shell: "approval", browserVisible: true }), {
    ssh: true,
    shellPath: ["/gh/bin"],
    mcp: ["s1", "s1", "s2"],
  });
  assert.ok(isDesiredAgent(agent));
  assert.equal(isDesiredAgent(profile()), false);
  assert.ok(Object.isFrozen(agent) && Object.isFrozen(agent.shell));
  assert.deepEqual(agent.shell, { level: "approval", pathPrepend: ["/gh/bin"] });
  assert.equal(agent.memory, true);
  assert.deepEqual(agent.skills.assigned, ["weather"]);
  assert.deepEqual(agent.mcp, { eligible: true, servers: ["s1", "s2"] });
  assert.deepEqual(agent.browser, { wanted: true, visible: true, profile: "agent-a1" });
  assert.equal(agent.web.webFetch, true);
  assert.equal(agent.web.webSearch, false);
  // Shell or an SSH grant keep a bot for other people away.
  assert.equal(agent.channels.telegram.eligible, false);
  assert.equal(desiredAgent(profile()).channels.telegram.eligible, true);
  assert.equal(
    desiredAgent(profile(), { stdio: true }).channels.telegram.eligible,
    false,
  );
});

test("an agent's grants yield exactly its profile tools for what the runtime offers", () => {
  const cases = [
    [profile({ shell: "full" }), { ssh: true }],
    [profile({ teamMemberId: "lead", lifetime: "permanent" }), {}],
    [
      profile({
        teamMemberId: "lead",
        lifetime: "temporary",
        inherited: { capabilities: { memory: true }, shell: "approval", ssh: true },
      }),
      { ssh: true },
    ],
    [profile({ userAccess: { mode: "own" }, shell: "full" }), {}],
    [profile({ archivedAt: "2026-10-01T00:00:00.000Z" }), {}],
  ];
  for (const [record, { ssh = false }] of cases)
    for (const state of [
      ready,
      { ...ready, writeGuard: false, available: { browser: false } },
      { teamsReady: false, nativeReady: true },
      { teamsReady: true, nativeReady: false },
    ]) {
      const mcpTools = ["files__*"];
      assert.deepEqual(
        grantedTools(desiredAgent(record, { ssh }).tools, { ...state, mcpTools }),
        profileTools(
          record,
          state.teamsReady,
          state.nativeReady,
          state.writeGuard,
          state.available,
          mcpTools,
          ssh,
        ),
      );
    }
  // A user agent holds no locked tool.
  const locked = desiredAgent(profile({ userAccess: { mode: "own" } }));
  assert.equal(locked.locked, true);
  assert.equal(grantedTools(locked.tools, ready).includes("exec"), false);
});

test("a live apply's model connection stays the caller's object", () => {
  const provider = { baseUrl: "http://127.0.0.1:9" };
  const agent = desiredAgent(profile(), {
    instructions: "# Agent",
    model: { ref: "p/m", providerId: "p", provider },
  });
  assert.equal(agent.instructions, "# Agent");
  assert.equal(agent.model.provider, provider);
  assert.equal(Object.isFrozen(provider), false);
});

test("the desired state carries the agents and the host's settings", () => {
  const mcp = {
    servers: [
      { id: "s1", name: "files", transport: "stdio" },
      { id: "s2", name: "web", transport: "http" },
    ],
    bindings: { a1: ["s1"], a2: ["s2"] },
    secrets: {},
    redirectUrl: null,
  };
  const state = desiredState({
    profiles: [profile(), profile({ id: "a2", runtimeAgentId: "ap-a2" })],
    sshAgents: new Set(["a2"]),
    githubShell: { a1: ["/gh"] },
    sshShell: { a1: ["/ssh"] },
    mcp,
    directory: "/plugin",
    connection: { url: "u", token: "t" },
    native: { token: "hook" },
    hostMaxConcurrent: 3,
    dreaming: { enabled: true, hour: 3, timeZone: "UTC" },
  });
  assert.ok(isDesiredState(state));
  assert.equal(isDesiredState(state.agents[0]), false);
  const [a1, a2] = state.agents;
  assert.deepEqual(a1.shell.pathPrepend, ["/gh", "/ssh"]);
  assert.deepEqual([a1.mcp.servers, a2.mcp.servers], [["s1"], ["s2"]]);
  // A stdio server or an SSH grant keeps the agent from owning a bot.
  assert.deepEqual(
    [a1.channels.telegram.eligible, a2.channels.telegram.eligible],
    [false, false],
  );
  assert.equal(a2.ssh, true);
  assert.deepEqual(state.host.team, {
    plugin: { directory: "/plugin", connection: { url: "u", token: "t" } },
    native: { token: "hook" },
    maxConcurrent: 3,
  });
  assert.equal(state.host.mcp.bindings, undefined);
  assert.equal(state.host.mcp.servers, mcp.servers);
  assert.deepEqual(state.host.dreaming, { enabled: true, hour: 3, timeZone: "UTC" });
  // Without the team plugin's bridge there is no plugin.
  assert.equal(desiredState({ directory: "/plugin" }).host.team.plugin, null);
  assert.deepEqual(desiredState().agents, []);
});
