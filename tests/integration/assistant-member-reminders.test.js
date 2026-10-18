import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

const model = { connectionId: "c", modelId: "m" };
const caps = (reminders) => ({ memory: false, reminders });

function setup(t) {
  const f = channelFixture(t);
  const lead = f.channel.assistantId;
  f.store.updateAssistant(lead, { capabilities: caps(true) }, 1);
  f.assistants.admit = (fn) => fn();
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  const jobs = new Map();
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.list") return { jobs: [...jobs.values()], hasMore: false };
    if (method === "cron.add") {
      const job = { ...input, id: `job-${jobs.size}`, updatedAtMs: 1, state: {} };
      jobs.set(job.id, job);
      return { created: true, job };
    }
    assert.fail(method);
  };
  const contexts = new Map();
  f.assistants.teams = { store: { context: (rid) => contexts.get(rid), list: () => [] } };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  t.after(() => reminders.close());
  // The lead granted its member reminders (TeamStore answers this in the app).
  f.store.memberGrants = () => ({ grants: { reminders: true }, shellSsh: false });
  const member = f.store.reserveMember({
    id: "member-1",
    parent: lead,
    assignment: { name: "Scout", role: "Research", assignment: "Look around" },
    snapshot: { instructions: "Plan", model },
    teamId: "team-1",
    lifetime: "task",
  });
  const chat = f.store.saveConversation({
    assistantId: member.id,
    runtimeSessionKey: "agent:member:task",
  });
  // A turn of the member with the context AgentPier recorded for it.
  const turn = (context, key) => {
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: key,
      text: "Go",
    });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    contexts.set(request.id, context);
    return { attemptId: attempt.id, toolCallId: key, assertCurrent() {} };
  };
  const create = (inv) =>
    reminders.invoke(inv, {
      action: "create",
      name: "Check",
      message: "Look at the build.",
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
    });
  const assigned = { kind: "team-member", teamId: "team-1", memberId: "member-1" };
  return { ...f, lead, member, reminders, turn, create, assigned, jobs };
}

test("a task member's reminder is created on its lead and delivered to the lead's chat", async (t) => {
  const f = setup(t);
  const reminder = await f.create(f.turn(f.assigned, "one"));
  assert.equal(reminder.status, "ready");
  assert.deepEqual(f.reminders.bindings.list(f.member.id), []);
  const [binding] = f.reminders.bindings.list(f.lead);
  assert.equal(binding.assistantId, f.lead);
  // The lead's main chat, and its paired Telegram chat as before.
  assert.equal(binding.target.conversationId, f.channel.conversationId);
  assert.equal(binding.telegram.channelId, f.channel.id);
  assert.equal(
    [...f.jobs.values()][0].agentId,
    f.store.getAssistant(f.lead).runtimeAgentId,
  );
});

test("a task member's reminder reaches a lead without Telegram in its main chat", async (t) => {
  const f = setup(t);
  f.service.store.disconnect(f.channel.id, f.channel.revision);
  const reminder = await f.create(f.turn(f.assigned, "unpaired"));
  assert.equal(reminder.status, "ready");
  assert.equal(reminder.telegram, false);
  const [binding] = f.reminders.bindings.list(f.lead);
  assert.equal(binding.target.conversationId, f.channel.conversationId);
});

test("a task member only creates reminders, in its lead's turns, while it holds them", async (t) => {
  const f = setup(t);
  await assert.rejects(
    async () => f.reminders.invoke(f.turn(f.assigned, "list"), { action: "list" }),
    { status: 403 },
  );
  await assert.rejects(async () => f.create(f.turn({ kind: "owner" }, "owner")), {
    status: 403,
  });
  const lead = f.store.getAssistant(f.lead);
  f.store.updateAssistant(f.lead, { capabilities: caps(false) }, lead.revision);
  await assert.rejects(async () => f.create(f.turn(f.assigned, "off")), { status: 403 });
  assert.equal(f.jobs.size, 0);
});

test("the bridge admits a task member's reminder and SSH calls only while granted", async (t) => {
  const f = setup(t);
  const bridge = new TeamBridge({
    assistants: {
      store: f.store,
      ledger: f.assistants.ledger,
      runtime: { client: { ready: true }, status: () => ({}) },
    },
    teams: {},
  });
  bridge.closed = false;
  const inv = f.turn(f.assigned, "bridge");
  const record = (action) => ({
    action,
    attemptId: inv.attemptId,
    sessionKey: "agent:member:task",
    agentId: f.member.runtimeAgentId,
    generation: 1,
  });
  assert.ok(bridge.valid(record("reminder")));
  // Shell and SSH were not granted; routines never are.
  assert.throws(() => bridge.valid(record("ssh")), { status: 403 });
  assert.throws(() => bridge.valid(record("routine")), { status: 403 });
  const lead = f.store.getAssistant(f.lead);
  f.store.updateAssistant(f.lead, { capabilities: caps(false) }, lead.revision);
  assert.throws(() => bridge.valid(record("reminder")), { status: 403 });
});
