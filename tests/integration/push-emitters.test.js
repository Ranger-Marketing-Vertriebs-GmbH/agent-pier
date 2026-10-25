import test from "node:test";
import assert from "node:assert/strict";
import { AgentApprovalEvents } from "../../server/application/agent-approval-events.js";
import { OperationsEvents } from "../../server/application/operations-events.js";
import { pushEvent } from "../../server/features/notifications/push-validation.js";

function fakeNotifications() {
  const sent = [];
  return {
    sent,
    status: () => ({ subscriptions: [{}] }),
    observations: new Map(),
    observation(key) {
      return this.observations.get(key);
    },
    observe(key, value) {
      this.observations.set(key, value);
    },
    // Every emitted event must pass the service's validation.
    notify: async (input) => {
      sent.push(input);
      pushEvent({
        ...input,
        preview: typeof input.preview === "string" ? input.preview : undefined,
      });
    },
  };
}

function fakeAssistants() {
  const actions = [],
    teams = [];
  return {
    actions,
    proposals: teams,
    store: {
      getAssistant: (id) => {
        if (id !== "mira") throw Error("not found");
        return { id, name: "Mira" };
      },
      listConversations: () => [
        { id: "chat-old", assistantId: "mira", archivedAt: "2026-01-01" },
        { id: "chat-main", assistantId: "mira" },
      ],
    },
    workflows: { store: { awaiting: () => actions } },
    teams: { store: { list: () => teams } },
  };
}

test("agent approvals and team proposals notify once, from the poll after startup", async () => {
  const notifications = fakeNotifications();
  const assistants = fakeAssistants();
  assistants.actions.push({
    id: "old",
    assistantId: "mira",
    payload: { action: "exec" },
  });
  const events = new AgentApprovalEvents({ services: { assistants }, notifications });
  await events.poll();
  // What already waited at startup never notifies late.
  assert.equal(notifications.sent.length, 0);
  assistants.actions.push({
    id: "ssh-one",
    assistantId: "mira",
    conversationId: "chat-old",
    payload: { action: "ssh", command: "rm -rf /", hostName: "prod" },
  });
  assistants.actions.push({ id: "odd", assistantId: "mira", payload: { action: "?" } });
  assistants.proposals.push({
    id: "team-one",
    phase: "awaiting_approval",
    parentAssistantId: "mira",
    objective: "Prepare the changelog",
  });
  assistants.proposals.push({
    id: "team-two",
    phase: "running",
    parentAssistantId: "mira",
  });
  await events.poll();
  await events.poll();
  assert.deepEqual(notifications.sent, [
    {
      kind: "agent-approval",
      eventId: "agent-action-ssh-one",
      subject: "ssh",
      assistantId: "mira",
      conversationId: "chat-main",
      label: "Mira",
      inbox: { type: "action", id: "ssh-one" },
    },
    {
      kind: "agent-approval",
      eventId: "agent-team-team-one",
      subject: "team",
      assistantId: "mira",
      conversationId: "chat-main",
      label: "Mira",
      inbox: { type: "team", id: "team-one" },
      preview: "Prepare the changelog",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(notifications.sent), /rm -rf|prod/);
  // An agent the store no longer knows still notifies, without a name.
  assistants.actions.push({
    id: "gone",
    assistantId: "ghost",
    payload: { action: "exec" },
  });
  await events.poll();
  assert.equal(notifications.sent.at(-1).label, undefined);
  assert.equal(notifications.sent.at(-1).assistantId, "ghost");
});

test("a waiting hook proposal sends the agent-approval push without its content", async () => {
  const notifications = fakeNotifications();
  const assistants = fakeAssistants();
  const events = new AgentApprovalEvents({ services: { assistants }, notifications });
  await events.poll();
  assistants.actions.push({
    id: "hook-one",
    assistantId: "mira",
    conversationId: "chat-main",
    payload: {
      action: "hook_proposal",
      approval: true,
      name: "Zabbix",
      sender: "zabbix01",
      reason: "Disk alarms",
    },
  });
  await events.poll();
  await events.poll();
  assert.deepEqual(notifications.sent, [
    {
      kind: "agent-approval",
      eventId: "agent-action-hook-one",
      subject: "hook",
      assistantId: "mira",
      conversationId: "chat-main",
      label: "Mira",
      inbox: { type: "action", id: "hook-one" },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(notifications.sent), /Zabbix|zabbix01|Disk/);
});

test("native requests, waits and runs name their session or pipeline", async (t) => {
  const notifications = fakeNotifications();
  const session = {
    id: "session-one",
    name: "api-refactor",
    tool: "claude",
    cwd: "/home/owner/shop-backend",
    status: "running",
  };
  const run = {
    id: "run-one",
    pipelineName: "Nightly checks",
    workingDir: "/home/owner/agent-pier",
    status: "running",
    currentNodeId: "review",
    nodes: [{ id: "review", profileSnapshot: { name: "Review" } }],
  };
  const events = new OperationsEvents({
    audit: { append() {} },
    notifications,
    sessions: { list: async () => [session], get: async () => session },
    requests: {
      listAll: () => [
        {
          id: "request-one",
          kind: "question",
          questions: [{ header: "DB", prompt: "Which database?" }],
        },
      ],
    },
    activity: { read: async () => ({ state: "idle" }) },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
  });
  t.after(() => events.close());
  events.emit({
    action: "request.created",
    resourceType: "request",
    resourceId: "request-one",
    sessionId: "session-one",
    kind: "question",
  });
  await new Promise(setImmediate);
  assert.deepEqual(notifications.sent[0], {
    kind: "question",
    eventId: "request-one",
    sessionId: "session-one",
    label: "api-refactor",
    tool: "claude",
    project: "shop-backend",
    inbox: { type: "question", id: "request-one" },
    preview: "Which database?",
  });
  events.pipeline(run);
  run.status = "awaiting-human";
  events.pipeline(run);
  run.status = "cancelled";
  events.pipeline(run);
  run.status = "failed";
  events.pipeline(run);
  await new Promise(setImmediate);
  const runs = notifications.sent.slice(1);
  assert.deepEqual(
    runs.map((r) => r.kind),
    ["pipeline-gate", "pipeline-failed"],
  );
  assert.deepEqual(runs[0].inbox, { type: "gate", id: "run-one" });
  assert.equal(runs[0].label, "Nightly checks");
  assert.equal(runs[0].stage, "Review");
  assert.equal(runs[0].project, "agent-pier");
  assert.equal(runs[1].inbox, undefined);
});
