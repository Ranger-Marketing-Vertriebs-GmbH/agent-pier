import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { AssistantEvents } from "../../server/features/assistants/assistant-events.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { OwnerInbox } from "../../server/features/inbox/owner-inbox.js";

const permission = {
  kind: "permission",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: { tool: "Bash", command: "rm -rf fixture-secret-command" },
};
const question = {
  kind: "question",
  questions: [
    {
      id: "q1",
      prompt: "Which framework?",
      header: "Framework",
      options: [{ id: "react", label: "React" }],
      multiple: false,
      allowOther: false,
    },
  ],
};

async function until(read, predicate, message = "condition") {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Timed out waiting for ${message}`);
}

/** Two running CLI sessions, a waiting run, one agent with a shell request, a team. */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-inbox-"));
  const clock = { now: Date.now() };
  const sessions = new Map(
    ["alpha", "beta"].map((id) => [
      id,
      {
        id,
        name: `Session ${id}`,
        tool: "claude",
        accountId: "account",
        status: "running",
        nativeRequests: { enabled: true },
      },
    ]),
  );
  sessions.set("gamma", { id: "gamma", name: "Stopped", status: "stopped" });
  const audit = new AuditStore({ dataDir: root });
  let inbox;
  const broker = new RequestBroker({
    dataDir: root,
    sessions: {
      get: async (id) => sessions.get(id),
      list: async () => [...sessions.values()],
    },
    onEvent: (event) => {
      audit.append(event);
      inbox?.changed();
    },
  });
  const channels = {};
  for (const id of ["alpha", "beta"]) {
    const launch = await broker.prepare({
      id,
      account: { id: "account", tool: "claude" },
      cwd: root,
      launch: { command: "/fixture/cli", args: [], env: {} },
    });
    channels[id] = new NativeRequestChannel({ env: launch.env });
    await channels[id].ready;
  }
  const store = new AssistantStore({ dataDir: path.join(root, "agents") });
  const agent = store.createAssistant({
    name: "Helper",
    model: { connectionId: "c", modelId: "m" },
  });
  const chat = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "agent:helper:main",
  });
  const actions = new AssistantActionStore(store.db);
  const exec = actions.reserve({
    assistantId: agent.id,
    conversationId: chat.id,
    key: "exec:one",
    payload: { action: "exec", command: "ls fixture", approvalId: "one" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
    expiresAt: clock.now + 5 * 60000,
  });
  const teams = [
    {
      id: "team-one",
      kind: "team",
      phase: "awaiting_approval",
      revision: 1,
      parentAssistantId: agent.id,
      parentConversationId: chat.id,
      objective: "Review the release",
      members: [{ name: "Ada" }, { name: "Bo" }],
      createdAt: new Date(clock.now - 60000).toISOString(),
      archivedAt: null,
    },
    { id: "team-two", kind: "team", phase: "approved", members: [] },
  ];
  const runs = [
    {
      id: "run-one",
      status: "awaiting-human",
      revision: 3,
      pipelineName: "Ship it",
      cwd: "/projects/app",
      currentNodeId: "review",
      nodes: [
        { id: "review", status: "awaiting-gate", profileSnapshot: { name: "Review" } },
      ],
      executionLog: [],
      createdAt: new Date(clock.now - 3600000).toISOString(),
    },
  ];
  const events = new AssistantEvents();
  const services = {
    sessions: { list: async () => [...sessions.values()] },
    requests: broker,
    pipelines: {
      store: { withStatus: (status) => runs.filter((r) => r.status === status) },
    },
    assistants: {
      store,
      events,
      workflows: { store: actions },
      teams: { store: { list: () => teams } },
    },
    audit,
  };
  inbox = new OwnerInbox({
    services,
    now: () => clock.now,
    intervalMs: 0,
    debounceMs: 5,
    maxAgeMs: 0,
  });
  t.after(async () => {
    inbox.close();
    for (const channel of Object.values(channels)) channel.close();
    await broker.close();
    store.close();
    audit.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    inbox,
    broker,
    channels,
    actions,
    exec,
    runs,
    teams,
    events,
    clock,
    agent,
    chat,
  };
}

test("requests of two sessions, a gate, a shell approval and a team proposal are all listed", async (t) => {
  const { inbox, channels, exec, agent, chat } = await fixture(t);
  channels.alpha.publish("ask", question, async () => {});
  channels.beta.publish("permit", permission, async () => {});
  const snapshot = await until(
    () => inbox.snapshot(),
    (s) => s.counts.questions === 1 && s.counts.approvals === 1,
    "both native requests",
  );
  assert.deepEqual(snapshot.counts, {
    all: 5,
    questions: 1,
    approvals: 1,
    gates: 1,
    agents: 2,
  });
  const byType = Object.fromEntries(snapshot.items.map((i) => [i.type, i]));
  assert.equal(byType.question.source.id, "alpha");
  assert.equal(byType.question.source.name, "Session alpha");
  assert.equal(byType.question.title, "Framework");
  assert.equal(byType.question.link, "/sessions/alpha/chat");
  assert.equal(byType.approval.source.id, "beta");
  assert.equal(byType.approval.title, "Bash");
  assert.equal(byType.gate.title, "Review");
  assert.equal(byType.gate.source.name, "Ship it");
  assert.equal(byType.gate.link, "/pipelines/runs/run-one");
  assert.equal(byType.action.id, exec.id);
  assert.equal(byType.action.kind, "exec");
  assert.equal(byType.action.link, `/agents/${agent.id}/chats/${chat.id}`);
  assert.equal(byType.team.title, "Review the release");
  assert.equal(byType.team.members, 2);
  for (const i of snapshot.items)
    for (const key of ["type", "id", "source", "title", "createdAt", "expiresAt", "link"])
      assert.ok(key in i, `${i.type} has ${key}`);
  // Command lines stay in the cards; the inbox list never carries them.
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes("fixture-secret-command"), false);
  assert.equal(text.includes("ls fixture"), false);
  assert.equal(text.includes("socket"), false);
  // The shell request expires in five minutes, so it comes first; then the longest
  // waiting: the run (an hour), the team proposal (a minute), the native requests.
  assert.deepEqual(snapshot.items.map((i) => i.type).slice(0, 3), [
    "action",
    "gate",
    "team",
  ]);
});

test("an answered request leaves the inbox, is pushed, and its link shows it was done", async (t) => {
  const { inbox, broker, channels } = await fixture(t);
  const delivered = [];
  channels.beta.publish("permit", permission, async (answer) => delivered.push(answer));
  const before = await until(
    () => inbox.snapshot(),
    (s) => s.counts.approvals === 1,
    "the approval",
  );
  const approval = before.items.find((i) => i.type === "approval");
  const pushed = [];
  const unsubscribe = inbox.subscribe((event) => pushed.push(event));
  t.after(unsubscribe);
  // The inline card answers through the session's own endpoint, as in the chat.
  await broker.answer("beta", approval.id, { expectedRevision: 1, choice: "allow" });
  assert.deepEqual(delivered, [{ choice: "allow" }]);
  await until(
    async () => pushed,
    (p) => p.some((e) => e.counts.approvals === 0),
    "the pushed change",
  );
  const after = await inbox.snapshot();
  assert.ok(after.revision > before.revision);
  assert.equal(
    after.items.some((i) => i.id === approval.id),
    false,
  );
  assert.equal(pushed.at(-1).type, "inbox");
  assert.equal(pushed.at(-1).revision, after.revision);
  assert.deepEqual(await inbox.status("approval", approval.id), {
    state: "done",
    outcome: "answered",
    at: (await inbox.status("approval", approval.id)).at,
    decision: "allow",
  });
  assert.deepEqual(await inbox.status("approval", "unknown-id"), { state: "gone" });
  const pending = await inbox.status("gate", "run-one");
  assert.equal(pending.state, "pending");
  assert.equal(pending.item.type, "gate");
});

test("an expired approval disappears and raises the revision; unchanged reads keep it", async (t) => {
  const { inbox, clock, exec, events, actions, runs, teams } = await fixture(t);
  const first = await inbox.snapshot();
  assert.equal((await inbox.snapshot()).revision, first.revision);
  clock.now = exec.expiresAt + 1;
  const expired = await inbox.snapshot();
  assert.equal(expired.counts.agents, 1);
  assert.equal(expired.revision, first.revision + 1);
  // A decided action, a decided team and a gate that moved on all leave the list.
  const pushed = [];
  inbox.subscribe((event) => pushed.push(event));
  teams[0].phase = "approved";
  runs[0].status = "running";
  events.publish({ type: "change" });
  await until(
    async () => pushed,
    (p) => p.length > 0,
    "the agent change",
  );
  const empty = await inbox.snapshot();
  assert.deepEqual(empty.counts, {
    all: 0,
    questions: 0,
    approvals: 0,
    gates: 0,
    agents: 0,
  });
  assert.equal(actions.awaiting(clock.now).length, 0);
});

test("a source that cannot be read leaves the others visible", async (t) => {
  const { inbox } = await fixture(t);
  const errors = [];
  inbox.onError = (_error, source) => errors.push(source);
  inbox.services.pipelines.store.withStatus = () => {
    throw Object.assign(Error("broken"), { code: "BROKEN" });
  };
  const snapshot = await inbox.snapshot();
  assert.equal(snapshot.counts.gates, 0);
  assert.equal(snapshot.counts.agents, 2);
  assert.deepEqual(errors, ["pipelines"]);
});

test("without agents the inbox lists the CLI and pipeline sources only", async (t) => {
  const { inbox } = await fixture(t);
  inbox.services.assistants = null;
  const snapshot = await inbox.snapshot();
  assert.equal(snapshot.counts.agents, 0);
  assert.equal(snapshot.counts.gates, 1);
});

test("the broker lists every session's requests without side effects or internals", async (t) => {
  const { broker, channels } = await fixture(t);
  channels.alpha.publish("ask", question, async () => {});
  const [entry] = await until(
    async () => broker.listAll(),
    (list) => list.length === 1,
    "the question",
  );
  for (const key of ["socket", "key", "accountId", "launchIdentity", "local"])
    assert.equal(key in entry, false, key);
  assert.equal(entry.sessionId, "alpha");
  assert.equal(broker.hasPending("alpha"), true);
  assert.equal(broker.hasPending("beta"), false);
  // Reading twice changes nothing, unlike the per-session list.
  assert.deepEqual(broker.listAll(), [entry]);
});
