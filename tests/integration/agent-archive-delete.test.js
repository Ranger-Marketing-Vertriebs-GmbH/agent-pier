import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lifecycleFixture } from "../helpers/agent-lifecycle-fixture.js";
import { AgentLifecycle } from "../../server/features/assistants/agent-lifecycle.js";

const rows = (f, sql, ...args) => f.store.db.prepare(sql).all(...args);

// A lead with `count` finished task members; `keep` of them kept as permanent agents.
async function leadWithMembers(f, { count = 2, keep = 0 } = {}) {
  const { team, parent, attempt } = await f.proposal({ count });
  await f.service.reconcile();
  for (const m of f.service.store.members(team.id)) f.complete(m.attemptId);
  await f.service.reconcile();
  const members = f.service.store.members(team.id);
  for (const m of members.slice(0, keep)) f.service.store.promote(m.id, m.revision);
  // The lead's own turn that proposed the team ends too.
  f.assistants.ledger.transition(attempt.id, "completed");
  return { lead: f.store.getAssistant(parent.id), team, members };
}

test("an own agent is archived and restored unchanged, audited by id", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, chat } = f.populated();
  await assert.rejects(f.lifecycle.archive(agent.id, { revision: agent.revision - 1 }), {
    status: 409,
  });
  const archived = await f.lifecycle.archive(agent.id, { revision: agent.revision });
  assert.ok(archived.archivedAt);
  assert.deepEqual(f.disabled, [agent.id]);
  assert.deepEqual(f.synced, [[agent.id, true]]);
  assert.deepEqual(f.assistants.browsers.stopped, [agent.id]);
  // An archived agent takes no turn, from any source.
  assert.throws(() => f.service.assertMemberTurn(agent.id, { kind: "owner" }), {
    status: 409,
  });
  // Archiving keeps every piece of its data.
  assert.equal(f.store.listConversations().filter((c) => c.id === chat.id).length, 1);
  assert.equal(f.bindings.list(agent.id).length, 1);
  const restored = await f.lifecycle.restore(agent.id, { revision: archived.revision });
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.instructions, agent.instructions);
  assert.deepEqual(f.synced.at(-1), [agent.id, false]);
  assert.deepEqual(
    f.audit.map((e) => [e.action, e.resourceId]),
    [
      ["assistant.archived", agent.id],
      ["assistant.restored", agent.id],
    ],
  );
  assert.doesNotMatch(JSON.stringify(f.audit), /Helper|Private/);
  await assert.rejects(f.lifecycle.restore(agent.id, { revision: restored.revision }), {
    status: 409,
  });
});

test("a permanent member and a user's agent are archived and restored", async (t) => {
  const f = lifecycleFixture(t);
  const { members } = await leadWithMembers(f, { count: 1, keep: 1 });
  const member = f.store.getAssistant(members[0].id);
  const archived = await f.lifecycle.archive(member.id, { revision: member.revision });
  assert.ok(archived.archivedAt);
  // The member archive of its team: the team record says so too.
  assert.ok(f.service.store.member(member.id).archivedAt);
  const restored = await f.lifecycle.restore(member.id, { revision: archived.revision });
  assert.equal(restored.archivedAt, null);
  assert.equal(f.service.store.member(member.id).archivedAt, null);
  const own = f.store.createAssistant(
    { name: "Anna's agent", instructions: "Help", model: f.model },
    { userAccess: { mode: "own", members: [{ userId: "anna", level: "extended" }] } },
  );
  const userArchived = await f.lifecycle.archive(own.id, { revision: own.revision });
  assert.ok(userArchived.archivedAt);
  assert.ok(f.store.getAssistant(own.id).userAccess);
  await f.lifecycle.restore(own.id, { revision: userArchived.revision });
  assert.equal(f.store.getAssistant(own.id).archivedAt, null);
});

test("a lead with temporary members asks first, then archives them too", async (t) => {
  const f = lifecycleFixture(t);
  const { lead, members } = await leadWithMembers(f, { count: 3, keep: 1 });
  const [kept, ...temporary] = members;
  await assert.rejects(f.lifecycle.archive(lead.id, { revision: lead.revision }), {
    status: 409,
    key: "leadHasMembers",
  });
  assert.equal(f.store.getAssistant(lead.id).archivedAt, null);
  await f.lifecycle.archive(lead.id, { revision: lead.revision, members: true });
  assert.ok(f.store.getAssistant(lead.id).archivedAt);
  for (const m of temporary) assert.ok(f.store.getAssistant(m.id).archivedAt);
  // Permanent members stay.
  assert.equal(f.store.getAssistant(kept.id).archivedAt, null);
  const event = f.audit.find((e) => e.action === "assistant.archived");
  assert.deepEqual(event.details.memberIds.sort(), temporary.map((m) => m.id).sort());
});

test("archiving refuses while a turn of the agent runs", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, chat } = f.populated();
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Busy",
  });
  f.assistants.ledger.recordAttempt(request.id);
  await assert.rejects(f.lifecycle.archive(agent.id, { revision: agent.revision }), {
    status: 409,
  });
});

test("only an archived agent is deleted, with its exact name", async (t) => {
  const f = lifecycleFixture(t);
  const { agent } = f.populated();
  await assert.rejects(f.lifecycle.delete(agent.id, { name: agent.name }), {
    status: 409,
    key: "agentNotArchived",
  });
  await f.lifecycle.archive(agent.id, { revision: agent.revision });
  await assert.rejects(f.lifecycle.delete(agent.id, { name: "helper" }), {
    status: 400,
    key: "agentDeleteName",
  });
  assert.ok(f.store.getAssistant(agent.id));
});

test("delete refuses while a turn runs or its configuration is applied", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, chat } = f.populated();
  await f.lifecycle.archive(agent.id, { revision: agent.revision });
  const request = f.assistants.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Late",
  });
  const attempt = f.assistants.ledger.recordAttempt(request.id);
  await assert.rejects(f.lifecycle.delete(agent.id, { name: agent.name }), {
    status: 409,
    key: "agentDeleteBusy",
  });
  f.assistants.ledger.transition(attempt.id, "completed");
  f.assistants.config.applying = (id) => id === agent.id;
  await assert.rejects(f.lifecycle.delete(agent.id, { name: agent.name }), {
    status: 409,
    key: "agentDeleteBusy",
  });
  f.assistants.config.applying = () => false;
  // OpenClaw removes the agent and its jobs: the Gateway must run.
  f.assistants.runtime.client.ready = false;
  await assert.rejects(f.lifecycle.delete(agent.id, { name: agent.name }), {
    status: 503,
    key: "agentDeleteService",
  });
  assert.equal(f.store.storedAssistant(agent.id).deletingAt, undefined);
});

test("delete removes every store of the agent and keeps everything else", async (t) => {
  const f = lifecycleFixture(t);
  const other = f.populated("Other");
  const { agent, workspace } = f.populated();
  const archived = await f.lifecycle.archive(agent.id, { revision: agent.revision });
  assert.ok(archived.archivedAt);
  const preview = f.lifecycle.deletion(agent.id);
  assert.deepEqual(preview, {
    id: agent.id,
    name: "Helper",
    counts: { chats: 1, routines: 2, memoryFiles: 2, workspaceFiles: 1, members: 0 },
  });
  const auditBefore = f.audit.length;
  await f.lifecycle.delete(agent.id, { name: "Helper" });
  assert.throws(() => f.store.storedAssistant(agent.id), { status: 404 });
  const id = agent.id;
  for (const [sql, args] of [
    ["SELECT 1 FROM conversations WHERE assistant_id=?", [id]],
    [
      "SELECT 1 FROM requests WHERE conversation_id IN (SELECT id FROM conversations WHERE assistant_id=?)",
      [id],
    ],
    ["SELECT 1 FROM agent_attachments WHERE assistant_id=?", [id]],
    ["SELECT 1 FROM assistant_reminder_bindings WHERE assistant_id=?", [id]],
    ["SELECT 1 FROM assistant_hooks WHERE assistant_id=?", [id]],
    ["SELECT 1 FROM assistant_actions WHERE assistant_id=?", [id]],
    ["SELECT 1 FROM assistant_access WHERE assistant_id=?", [id]],
    ["SELECT 1 FROM assistant_team_records WHERE id=? OR parent_id=?", [id, id]],
  ])
    assert.deepEqual(rows(f, sql, ...args), [], sql);
  assert.equal(rows(f, "SELECT 1 FROM messages").length, 1);
  assert.equal(rows(f, "SELECT 1 FROM requests").length, 1);
  // Native: OpenClaw's own delete takes its entry and every cron job of the agent;
  // AgentPier deletes the files itself, never into a trash folder.
  assert.deepEqual(f.deletedAgents, [
    { agentId: agent.runtimeAgentId, deleteFiles: false },
  ]);
  assert.deepEqual(f.removedJobs.sort(), [`job-${id}`, `own-${id}`]);
  assert.ok(f.roster.has(other.agent.runtimeAgentId));
  assert.deepEqual(f.forgotten, [`channel-${id}`]);
  assert.deepEqual(f.unbound, [["agent", id, []]]);
  for (const dir of [
    workspace,
    path.join(f.paths.state, "agents", agent.runtimeAgentId),
    path.join(f.paths.state, "browser", `agent-${id}`),
  ])
    assert.equal(fs.existsSync(dir), false, dir);
  // The other agent keeps everything.
  assert.ok(fs.existsSync(other.workspace));
  assert.ok(f.store.getAssistant(other.agent.id));
  assert.equal(f.bindings.list(other.agent.id).length, 1);
  assert.equal(f.cron.length, 2);
  // Earlier audit entries stay; the delete is audited with ids and counts only.
  assert.equal(f.audit.length, auditBefore + 1);
  const deleted = f.audit.at(-1);
  assert.equal(deleted.action, "assistant.deleted");
  assert.equal(deleted.resourceId, id);
  assert.deepEqual(deleted.details, {
    chats: 1,
    routines: 2,
    memoryFiles: 2,
    workspaceFiles: 1,
    members: 0,
  });
  assert.doesNotMatch(JSON.stringify(f.audit), /Helper|Private|Plan/);
  assert.equal(
    f.assistants.list().assistants.some((a) => a.id === id),
    false,
  );
});

test("a lead is deleted with its temporary members, never with permanent ones", async (t) => {
  const f = lifecycleFixture(t);
  const one = await leadWithMembers(f, { count: 2 });
  await f.lifecycle.archive(one.lead.id, { revision: one.lead.revision, members: true });
  assert.equal(f.lifecycle.deletion(one.lead.id).counts.members, 2);
  await f.lifecycle.delete(one.lead.id, { name: "Parent" });
  for (const m of one.members)
    assert.throws(() => f.store.storedAssistant(m.id), { status: 404 });
  assert.deepEqual(rows(f, "SELECT 1 FROM assistant_team_records WHERE kind='team'"), []);
  const two = await leadWithMembers(f, { count: 1, keep: 1 });
  await f.lifecycle.archive(two.lead.id, { revision: two.lead.revision });
  await assert.rejects(f.lifecycle.delete(two.lead.id, { name: "Parent" }), {
    status: 409,
    key: "agentDeleteMembers",
  });
  assert.ok(f.store.getAssistant(two.members[0].id));
});

test("a delete stopped after its mark resumes at the next start", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, workspace } = f.populated();
  const archived = await f.lifecycle.archive(agent.id, { revision: agent.revision });
  // As a crash right after the mark: the purge never ran.
  f.lifecycle.markDeleting(agent.id);
  assert.ok(f.store.storedAssistant(agent.id).deletingAt);
  // Never listed, never restored, never run.
  assert.equal(
    f.assistants.list().assistants.some((a) => a.id === agent.id),
    false,
  );
  await assert.rejects(f.lifecycle.restore(agent.id, { revision: archived.revision }), {
    status: 404,
  });
  assert.throws(() => f.service.assertMemberTurn(agent.id, { kind: "owner" }), {
    status: 409,
  });
  assert.ok(fs.existsSync(workspace));
  const restarted = new AgentLifecycle(f.services);
  // A start without a running Gateway leaves it marked.
  f.assistants.runtime.client.ready = false;
  await restarted.resume();
  assert.ok(f.store.storedAssistant(agent.id).deletingAt);
  f.assistants.runtime.client.ready = true;
  await restarted.resume();
  assert.throws(() => f.store.storedAssistant(agent.id), { status: 404 });
  assert.equal(fs.existsSync(workspace), false);
  const deleted = f.audit.at(-1);
  assert.equal(deleted.action, "assistant.deleted");
  assert.equal(deleted.details.chats, 1);
  // Nothing left to resume.
  await restarted.resume();
  assert.equal(f.audit.filter((e) => e.action === "assistant.deleted").length, 1);
});
