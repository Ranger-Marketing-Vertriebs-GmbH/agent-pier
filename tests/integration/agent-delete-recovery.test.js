import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { leadWithMembers, lifecycleFixture } from "../helpers/agent-lifecycle-fixture.js";
import { AgentLifecycle } from "../../server/features/assistants/agent-lifecycle.js";

const rows = (f, sql, ...args) => f.store.db.prepare(sql).all(...args);
const pending = (f) => f.assistants.list().deletions;

test("a lead is deleted with its temporary members, never with permanent ones", async (t) => {
  const f = lifecycleFixture(t);
  const one = await leadWithMembers(f, { count: 2 });
  await f.lifecycle.archive(one.lead.id, { revision: one.lead.revision, members: true });
  assert.equal((await f.lifecycle.deletion(one.lead.id)).counts.members, 2);
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

test("a permanent member is deleted alone with what its lead keeps of it", async (t) => {
  const f = lifecycleFixture(t);
  const { lead, team, members } = await leadWithMembers(f, { count: 1, keep: 1 });
  const member = f.store.getAssistant(members[0].id);
  const insert = (sql, ...args) => f.store.db.prepare(sql).run(...args);
  // A request of its lead to it, with its text, and a grant request waiting for it.
  insert(
    "INSERT INTO assistant_team_records VALUES(?,?,?,?,?,?,?)",
    "request-1",
    "lead-request",
    lead.id,
    null,
    "completed",
    1,
    JSON.stringify({ id: "request-1", kind: "lead-request", memberId: member.id }),
  );
  insert(
    "INSERT INTO assistant_team_records VALUES(?,?,?,?,?,?,?)",
    "text-1",
    "text",
    "request-1",
    null,
    null,
    1,
    JSON.stringify({ id: "text-1", kind: "text", text: "Private" }),
  );
  insert(
    "INSERT INTO assistant_actions VALUES(?,?,?,?)",
    "grant-1",
    lead.id,
    "grant-op",
    JSON.stringify({ id: "grant-1", payload: { memberId: member.id } }),
  );
  const archived = await f.lifecycle.archive(member.id, { revision: member.revision });
  await f.lifecycle.delete(member.id, { name: archived.name });
  assert.throws(() => f.store.storedAssistant(member.id), { status: 404 });
  for (const id of ["request-1", "text-1", member.id])
    assert.equal(f.service.store.find(id), null, id);
  assert.deepEqual(rows(f, "SELECT 1 FROM assistant_actions WHERE id='grant-1'"), []);
  // The lead, its team and the owner's lists stay intact.
  assert.ok(f.store.getAssistant(lead.id));
  assert.ok(f.service.store.get(team.id));
  assert.ok(f.service.list().teams.length);
  assert.ok(f.assistants.list().assistants.some((a) => a.id === lead.id));
});

test("a delete stopped after its mark resumes at the next start", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, workspace } = f.populated();
  const archived = await f.lifecycle.archive(agent.id, { revision: agent.revision });
  // As a crash right after the mark: the purge never ran.
  await f.lifecycle.markDeleting(agent.id);
  assert.ok(f.store.storedAssistant(agent.id).deletingAt);
  // Never listed as an agent, never restored, never run; listed as pending.
  assert.equal(
    f.assistants.list().assistants.some((a) => a.id === agent.id),
    false,
  );
  assert.deepEqual(pending(f), [{ id: agent.id, name: "Helper", error: null }]);
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
  assert.deepEqual(f.remains(agent.id), { files: [], rows: {} });
  assert.deepEqual(pending(f), []);
  const deleted = f.audit.at(-1);
  assert.equal(deleted.action, "assistant.deleted");
  assert.equal(deleted.details.chats, 1);
  // Nothing left to resume.
  await restarted.resume();
  assert.equal(f.audit.filter((e) => e.action === "assistant.deleted").length, 1);
});

test("a delete failing after the Gateway step stays pending and resumes", async (t) => {
  const f = lifecycleFixture(t);
  const { agent } = f.populated();
  await f.lifecycle.archive(agent.id, { revision: agent.revision });
  f.fail.forget.add(`channel-${agent.id}`);
  await assert.rejects(f.lifecycle.delete(agent.id, { name: "Helper" }), {
    code: "CHANNEL_BUSY",
  });
  // The Gateway step was done; the record stays, pending with its code.
  assert.deepEqual(f.deletedAgents.length, 1);
  assert.deepEqual(pending(f), [{ id: agent.id, name: "Helper", error: "CHANNEL_BUSY" }]);
  assert.equal((await f.lifecycle.deletion(agent.id)).pending, true);
  await new AgentLifecycle(f.services).resume();
  assert.deepEqual(f.remains(agent.id), { files: [], rows: {} });
  // Its Telegram follow-ups go too, though its channel was found again only by id.
  assert.deepEqual(pending(f), []);
});

test("a lead's delete failing partway, after its members, resumes", async (t) => {
  const f = lifecycleFixture(t);
  const { lead, members } = await leadWithMembers(f, { count: 2 });
  f.fill(
    lead,
    ...(() => {
      const chat = f.store.listConversations().find((c) => c.assistantId === lead.id);
      const request = f.assistants.ledger.requests(chat.id)[0];
      return [chat, request, f.assistants.ledger.attemptFor(request.id)];
    })(),
  );
  await f.lifecycle.archive(lead.id, { revision: lead.revision, members: true });
  f.fail.forget.add(`channel-${lead.id}`);
  await assert.rejects(f.lifecycle.delete(lead.id, { name: "Parent" }));
  // Its members are gone; the lead waits, pending with its members' ids.
  for (const m of members) assert.equal(f.lifecycle.exists(m.id), false);
  assert.deepEqual(
    pending(f).map((d) => [d.id, d.error]),
    [[lead.id, "CHANNEL_BUSY"]],
  );
  await new AgentLifecycle(f.services).resume();
  assert.equal(f.lifecycle.exists(lead.id), false);
  assert.deepEqual(f.remains(lead.id).rows, {});
  const deleted = f.audit.filter((e) => e.action === "assistant.deleted");
  assert.deepEqual(
    deleted.map((e) => e.details.members),
    [2],
  );
});

test("a failing agents.delete leaves it pending; a retry and a start finish it", async (t) => {
  const f = lifecycleFixture(t);
  const first = f.populated("First");
  const second = f.populated("Second");
  for (const { agent } of [first, second])
    await f.lifecycle.archive(agent.id, { revision: agent.revision });
  f.fail.agentsDelete = 1;
  await assert.rejects(f.lifecycle.delete(first.agent.id, { name: "First" }), {
    code: "UNAVAILABLE",
  });
  assert.deepEqual(pending(f), [
    { id: first.agent.id, name: "First", error: "UNAVAILABLE" },
  ]);
  // Nothing of it was removed yet.
  assert.equal(f.remains(first.agent.id).files.length, 6);
  // A retry still asks for the name.
  await assert.rejects(f.lifecycle.delete(first.agent.id, { name: "first" }), {
    key: "agentDeleteName",
  });
  await f.lifecycle.delete(first.agent.id, { name: "First" });
  assert.deepEqual(f.remains(first.agent.id), { files: [], rows: {} });
  // A start goes on past an agent that fails again.
  await f.lifecycle.markDeleting(second.agent.id);
  const third = f.populated("Third");
  await f.lifecycle.archive(third.agent.id, { revision: third.agent.revision });
  await f.lifecycle.markDeleting(third.agent.id);
  f.fail.agentsDelete = 1;
  await new AgentLifecycle(f.services).resume();
  assert.deepEqual(pending(f), [
    { id: second.agent.id, name: "Second", error: "UNAVAILABLE" },
  ]);
  assert.equal(f.lifecycle.exists(third.agent.id), false);
  await new AgentLifecycle(f.services).resume();
  assert.deepEqual(pending(f), []);
});
