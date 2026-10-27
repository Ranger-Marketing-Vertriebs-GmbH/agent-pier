import test from "node:test";
import assert from "node:assert/strict";
import { leadWithMembers, lifecycleFixture } from "../helpers/agent-lifecycle-fixture.js";
import { AgentLifecycle } from "../../server/features/assistants/agent-lifecycle.js";
import { purgeAgent } from "../../server/features/assistants/agent-deletion.js";

// Cron jobs agents made themselves pause on every archive path and come back on
// restore (agent-own-jobs.js), also when the Gateway fails partway or is away.
const ownJob = (f, agent) => {
  const job = { id: `own-${agent.id}`, agentId: agent.runtimeAgentId, enabled: true };
  f.cron.push(job);
  return job;
};
const stored = (f, id) => f.store.storedAssistant(id).ownJobs ?? null;

test("a lead's temporary members archived with it pause their own jobs", async (t) => {
  const f = lifecycleFixture(t);
  const { lead, members } = await leadWithMembers(f, { count: 2 });
  const jobs = members.map((m) => ownJob(f, f.store.storedAssistant(m.id)));
  await f.lifecycle.archive(lead.id, { revision: lead.revision, members: true });
  assert.deepEqual(
    jobs.map((j) => j.enabled),
    [false, false],
  );
  for (const m of members) assert.deepEqual(stored(f, m.id), { paused: [`own-${m.id}`] });
});

test("the team routes' archive and restore pause and enable own jobs", async (t) => {
  const f = lifecycleFixture(t);
  const { team, members } = await leadWithMembers(f, { count: 2, keep: 1 });
  const [kept] = members;
  const job = ownJob(f, f.store.storedAssistant(kept.id));
  // /assistant-team-members/:id/archive and /restore call the team lifecycle.
  const record = f.service.store.member(kept.id);
  const archived = await f.service.lifecycle("archive", kept.id, record.revision);
  assert.equal(job.enabled, false);
  await f.service.lifecycle("restore", kept.id, archived.revision);
  assert.equal(job.enabled, true);
  assert.equal(stored(f, kept.id), null);
  // /assistant-teams/:id/archive and /restore do the same for every member.
  const jobs = members.slice(1).map((m) => ownJob(f, f.store.storedAssistant(m.id)));
  const current = f.service.store.get(team.id);
  await f.service.lifecycle("archive", team.id, current.revision);
  assert.deepEqual(
    [job, ...jobs].map((j) => j.enabled),
    [false, false],
  );
  await f.service.lifecycle("restore", team.id, f.service.store.get(team.id).revision);
  assert.deepEqual(
    [job, ...jobs].map((j) => j.enabled),
    [true, true],
  );
});

test("a pause failing partway keeps what it paused; restore enables it", async (t) => {
  const f = lifecycleFixture(t);
  const { agent } = f.populated();
  const second = { id: `own2-${agent.id}`, agentId: agent.runtimeAgentId, enabled: true };
  f.cron.push(second);
  f.fail.cronUpdate.add(second.id);
  const archived = await f.lifecycle.archive(agent.id, { revision: agent.revision });
  assert.ok(archived.archivedAt);
  assert.deepEqual(stored(f, agent.id), {
    pending: "pause",
    paused: [`own-${agent.id}`],
  });
  // The next start pauses the rest.
  await new AgentLifecycle(f.services).resume();
  assert.deepEqual(stored(f, agent.id), {
    paused: [`own-${agent.id}`, second.id],
  });
  await f.lifecycle.restore(agent.id, {
    revision: f.store.storedAssistant(agent.id).revision,
  });
  assert.equal(second.enabled, true);
  assert.equal(f.cron.find((j) => j.id === `own-${agent.id}`).enabled, true);
});

test("restore and archive again while the Gateway is away keep the paused list", async (t) => {
  const f = lifecycleFixture(t);
  const { agent } = f.populated();
  const own = f.cron.find((j) => j.id === `own-${agent.id}`);
  await f.lifecycle.archive(agent.id, { revision: agent.revision });
  assert.equal(own.enabled, false);
  f.assistants.runtime.client.ready = false;
  await f.lifecycle.restore(agent.id, {
    revision: f.store.storedAssistant(agent.id).revision,
  });
  assert.deepEqual(stored(f, agent.id), { pending: "resume", paused: [own.id] });
  // Archived again before any start: the list it paused earlier is kept.
  f.assistants.reminders.disable = async () => {};
  await f.lifecycle.archive(agent.id, {
    revision: f.store.storedAssistant(agent.id).revision,
  });
  assert.deepEqual(stored(f, agent.id), { pending: "pause", paused: [own.id] });
  f.assistants.runtime.client.ready = true;
  await new AgentLifecycle(f.services).resume();
  assert.deepEqual(stored(f, agent.id), { paused: [own.id] });
  await f.lifecycle.restore(agent.id, {
    revision: f.store.storedAssistant(agent.id).revision,
  });
  assert.equal(own.enabled, true);
});

test("a member's pause failing never fails its archive; a start settles it", async (t) => {
  const f = lifecycleFixture(t);
  const { members } = await leadWithMembers(f, { count: 1, keep: 1 });
  const member = f.store.getAssistant(members[0].id);
  const job = ownJob(f, member);
  f.fail.jobs.add(member.runtimeAgentId);
  const archived = await f.lifecycle.archive(member.id, { revision: member.revision });
  assert.ok(archived.archivedAt);
  assert.deepEqual(stored(f, member.id), { pending: "pause", paused: [] });
  assert.equal(job.enabled, true);
  f.fail.jobs.clear();
  await new AgentLifecycle(f.services).resume();
  assert.equal(job.enabled, false);
  assert.deepEqual(stored(f, member.id), { paused: [job.id] });
});

test("settling at a start goes on past an agent that fails", async (t) => {
  const f = lifecycleFixture(t);
  const first = f.populated("First");
  const second = f.populated("Second");
  f.assistants.runtime.client.ready = false;
  f.assistants.reminders.disable = async () => {};
  for (const { agent } of [first, second])
    await f.lifecycle.archive(agent.id, { revision: agent.revision });
  f.assistants.runtime.client.ready = true;
  f.fail.jobs.add(first.agent.runtimeAgentId);
  await new AgentLifecycle(f.services).resume();
  assert.equal(stored(f, first.agent.id).pending, "pause");
  assert.deepEqual(stored(f, second.agent.id), { paused: [`own-${second.agent.id}`] });
});

test("a pending member delete whose lead is gone shows and is retried", async (t) => {
  const f = lifecycleFixture(t);
  const { lead, members } = await leadWithMembers(f, { count: 1 });
  await f.lifecycle.archive(lead.id, { revision: lead.revision, members: true });
  await f.lifecycle.markDeleting(lead.id);
  // As a crash after the lead was purged but before its member was.
  await purgeAgent(f.lifecycle.s, f.store.storedAssistant(lead.id));
  const member = f.store.storedAssistant(members[0].id);
  assert.deepEqual(
    f.assistants.list().deletions.map((d) => d.id),
    [member.id],
  );
  await f.lifecycle.delete(member.id, { name: member.name });
  assert.equal(f.lifecycle.exists(member.id), false);
  assert.deepEqual(f.assistants.list().deletions, []);
});
