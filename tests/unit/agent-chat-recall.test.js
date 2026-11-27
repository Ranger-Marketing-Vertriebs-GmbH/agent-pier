import test from "node:test";
import assert from "node:assert/strict";
import {
  lockedTools,
  profileTools,
  recallRefused,
  recallsChats,
  recallTools,
  routineTools,
  senderLockedTools,
  sessionTools,
} from "../../server/features/assistants/native-capabilities.js";
import { agentEntry } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/agent-entry.js";
import { nativeTools } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { lockedCoreTools } from "../../server/features/assistants/team-plugin/tool-guard.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

// An agent looks up its own earlier chats with OpenClaw's read-only session tools
// while its memory is on (native-capabilities.js recallTools).
const own = { id: "a", runtimeAgentId: "ap-a", capabilities: { memory: true } };
const tools = (agent, nativeReady = true) => profileTools(agent, true, nativeReady);
const holds = (agent, nativeReady) =>
  recallTools.filter((tool) => tools(agent, nativeReady).includes(tool));

test("the recall tools are OpenClaw's three read-only session tools", () => {
  assert.deepEqual(recallTools, ["sessions_list", "sessions_history", "sessions_search"]);
  // Never a tool that runs, steers or changes a session.
  for (const tool of ["sessions_send", "sessions_spawn", "sessions", "sessions_create"])
    assert.equal(recallTools.includes(tool), false, tool);
  for (const tool of recallTools) {
    assert.ok(sessionTools.includes(tool), tool);
    assert.ok(nativeTools.includes(tool), tool);
    // Every call still asks the bridge (tool-guard.js lockedToolCall).
    assert.ok(lockedCoreTools.includes(tool), tool);
  }
});

test("an agent with memory holds the recall tools, one without does not", () => {
  assert.deepEqual(holds(own), recallTools);
  assert.equal(recallsChats(own), true);
  assert.deepEqual(holds({ ...own, capabilities: { memory: false } }), []);
  assert.deepEqual(holds({ ...own, capabilities: { reminders: true } }), []);
  // Only with AgentPier's native tools, and never once archived.
  assert.deepEqual(holds(own, false), []);
  assert.deepEqual(holds({ ...own, archivedAt: "today" }), []);
  // No agent holds a session tool that writes.
  for (const agent of [own, { ...own, shell: "full" }])
    for (const tool of ["sessions_send", "sessions_spawn"])
      assert.equal(tools(agent).includes(tool), false, tool);
});

test("a permanent member recalls with its own memory, a temporary member never", () => {
  const permanent = { ...own, teamMemberId: "t", lifetime: "permanent" };
  assert.deepEqual(holds(permanent), recallTools);
  assert.deepEqual(holds({ ...permanent, capabilities: { memory: false } }), []);
  // A temporary member's memory is always on, yet it reads no earlier chats: not with
  // its lead's memory grant either.
  const temporary = {
    ...own,
    teamMemberId: "t",
    lifetime: "task",
    inherited: { capabilities: { memory: true }, skills: [], shell: "off" },
  };
  assert.ok(tools(temporary).includes("memory_search"));
  assert.deepEqual(holds(temporary), []);
  assert.equal(recallsChats(temporary), false);
});

test("an agent of users never reads earlier chats: they are other people's", () => {
  for (const mode of ["own", "shared"]) {
    const agent = { ...own, userAccess: { mode, members: [] } };
    assert.deepEqual(holds(agent), [], mode);
    assert.equal(recallsChats(agent), false, mode);
    const entry = agentEntry({}, agent, { teamsReady: true, nativeReady: true });
    for (const tool of recallTools) {
      assert.equal(entry.tools.allow.includes(tool), false, tool);
      assert.ok(entry.tools.deny.includes(tool), tool);
    }
  }
  for (const tool of recallTools) assert.ok(lockedTools.includes(tool), tool);
});

test("an agent with its own bot for other people is compiled without them", () => {
  const allow = (senderFacing) =>
    agentEntry({}, own, { teamsReady: true, nativeReady: true, senderFacing }).tools
      .allow;
  for (const tool of recallTools) {
    assert.ok(allow(false).includes(tool), tool);
    assert.equal(allow(true).includes(tool), false, tool);
    assert.ok(senderLockedTools.includes(tool), tool);
  }
});

test("a routine's run may recall", () => {
  // OpenClaw intersects the run's cap with the agent's own list, so only an agent
  // that recalls in its chats recalls in its routines.
  for (const tool of recallTools) assert.ok(routineTools.includes(tool), tool);
  for (const tool of ["sessions_send", "sessions_spawn"])
    assert.equal(routineTools.includes(tool), false, tool);
  // A hook's run works on an outside event and never recalls: the bridge refuses
  // it every session tool but session_status (tests/integration/agent-hook-bridge).
});

test("the tool guard's bridge refuses a recall call the agent may not make", () => {
  const user = {
    id: "u",
    runtimeAgentId: "ap-u",
    capabilities: { memory: true },
    userAccess: { mode: "shared", members: [] },
  };
  const plain = { id: "p", runtimeAgentId: "ap-p", capabilities: { memory: false } };
  const bot = { id: "b", runtimeAgentId: "ap-b", capabilities: { memory: true } };
  const assistants = {
    store: { listAssistants: () => [own, user, plain, bot] },
    runtime: { client: { ready: true }, status: () => ({}) },
    ledger: { pending: () => [] },
    config: { senderFacing: (agent) => agent.id === "b" },
  };
  const bridge = new TeamBridge({ assistants, teams: {} });
  bridge.closed = false;
  const allowed = (agentId, toolName) =>
    bridge.toolPolicy({ agentId, sessionKey: "s", toolName }).allow;
  for (const toolName of recallTools) {
    assert.equal(allowed("ap-a", toolName), true, toolName);
    // A stale or forged entry that still names the tool is refused at run time.
    assert.equal(allowed("ap-u", toolName), false, toolName);
    assert.equal(allowed("ap-p", toolName), false, toolName);
    assert.equal(allowed("ap-b", toolName), false, toolName);
    assert.equal(allowed("ap-unknown", toolName), false, toolName);
  }
  // Other locked tools of an own agent are unaffected.
  assert.equal(allowed("ap-p", "session_status"), true);
  assert.equal(allowed("ap-p", "exec"), true);
  assert.equal(recallRefused(plain, "exec"), false);
});
