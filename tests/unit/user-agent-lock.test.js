import test from "node:test";
import assert from "node:assert/strict";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";
import {
  delegationTools,
  personalShell,
  profileTools,
  sessionTools,
} from "../../server/features/assistants/native-capabilities.js";
import { lockedTools } from "../../server/features/users/user-agent-lock.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "chat" }],
  released: [],
};
const agent = {
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, reminders: true, webSearch: true },
  shell: "full",
  skills: ["weather"],
  userAccess,
};

test("the locked tools are shell, ssh, team and session tools", () => {
  for (const tool of ["exec", "process", "agentpier_ssh"])
    assert.ok(lockedTools.includes(tool), tool);
  for (const tool of [...delegationTools, ...sessionTools])
    assert.ok(lockedTools.includes(tool), tool);
});

test("a user agent never compiles shell, ssh, team or session tools", () => {
  const entry = agentEntry({ id: "ap-a1" }, agent, {
    teamsReady: true,
    nativeReady: true,
    guardProven: true,
    ssh: true,
    pathPrepend: ["/owner/bin"],
  });
  for (const tool of lockedTools) assert.ok(!entry.tools.allow.includes(tool), tool);
  assert.deepEqual(entry.tools.deny, lockedTools);
  assert.equal(entry.tools.exec, undefined);
  assert.ok(entry.tools.allow.includes("memory_search"));
  assert.ok(entry.tools.allow.includes("agentpier_reminder"));
  assert.ok(entry.tools.allow.includes("agentpier_workspace"));
  // Skills stay as compiled.
  assert.deepEqual(entry.skills, ["weather"]);
  assert.equal(personalShell(agent), "off");
  const tools = profileTools(agent, true, true, true, {}, [], true);
  for (const tool of lockedTools) assert.ok(!tools.includes(tool), tool);
  // The same agent without the assignment keeps its shell and team tools.
  const owner = { ...agent, userAccess: undefined };
  const ownerEntry = agentEntry({ id: "ap-a1" }, owner, {
    teamsReady: true,
    nativeReady: true,
    guardProven: true,
    ssh: true,
  });
  assert.ok(ownerEntry.tools.allow.includes("exec"));
  assert.ok(ownerEntry.tools.allow.includes("agentpier_team_propose"));
  assert.equal(ownerEntry.tools.deny, undefined);
});

test("an unmanaged user agent still gets an explicit deny", () => {
  const entry = agentEntry({ id: "ap-a1", tools: { exec: { mode: "full" } } }, agent, {
    teamsReady: false,
    nativeReady: false,
    guardProven: false,
  });
  assert.deepEqual(entry.tools, { allow: [], deny: lockedTools });
  const kept = agentEntry({ id: "ap-a1", tools: { allow: ["read", "exec"] } }, agent, {
    teamsReady: false,
    nativeReady: false,
    guardProven: false,
  });
  assert.deepEqual(kept.tools, { allow: ["read"], deny: lockedTools });
});

test("the tool guard refuses exec and team calls for a user agent", () => {
  const assistants = {
    store: { listAssistants: () => [agent] },
    runtime: { client: { ready: true }, status: () => ({}) },
    ledger: { pending: () => [] },
  };
  const bridge = new TeamBridge({ assistants, teams: {} });
  bridge.closed = false;
  for (const toolName of ["exec", "process", "agentpier_ssh", "sessions_send"])
    assert.deepEqual(
      bridge.toolPolicy({ agentId: "ap-a1", sessionKey: "s", toolName, path: "x" }),
      { allow: false },
      toolName,
    );
  // Another agent keeps its locked tools; the plugin asks for each call.
  assert.deepEqual(
    bridge.toolPolicy({ agentId: "ap-other", sessionKey: "s", toolName: "exec" }),
    { allow: true },
  );
  for (const action of ["propose", "delegate", "ssh"])
    assert.throws(
      () =>
        bridge.valid({
          agentId: "ap-a1",
          sessionKey: "s",
          action,
          attemptId: "x",
          generation: 1,
        }),
      { status: 403 },
      action,
    );
});

test("a user agent keeps the MCP servers the owner bound", () => {
  const entry = agentEntry({ id: "ap-a1" }, agent, {
    teamsReady: true,
    nativeReady: true,
    guardProven: true,
    mcpTools: ["local__*"],
  });
  assert.ok(entry.tools.allow.includes("local__*"));
});
