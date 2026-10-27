import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { leadWithMembers, lifecycleFixture } from "../helpers/agent-lifecycle-fixture.js";
import { agentTables } from "../../server/features/assistants/agent-deletion.js";

test("an own agent is archived and restored unchanged, audited by id", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, chat } = f.populated();
  await assert.rejects(f.lifecycle.archive(agent.id, { revision: agent.revision - 1 }), {
    status: 409,
  });
  // An agent answering people on its own Telegram bot is never archived.
  f.assistants.telegramSenders.connected = (id) => id === agent.id;
  await assert.rejects(f.lifecycle.archive(agent.id, { revision: agent.revision }), {
    status: 409,
    key: "telegramSendersArchive",
  });
  f.assistants.telegramSenders.connected = () => false;
  const archived = await f.lifecycle.archive(agent.id, { revision: agent.revision });
  assert.ok(archived.archivedAt);
  assert.deepEqual(f.disabled, [agent.id]);
  assert.deepEqual(f.synced, [[agent.id, true]]);
  assert.deepEqual(f.assistants.browsers.stopped, [agent.id]);
  // A cron job the agent made itself pauses; AgentPier's own jobs follow its bindings.
  assert.deepEqual(f.updatedJobs, [[`own-${agent.id}`, false]]);
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
  assert.deepEqual(f.updatedJobs.at(-1), [`own-${agent.id}`, true]);
  assert.equal(restored.ownJobs, null);
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
  // Once its user is gone, it is not restored again: it can only be deleted.
  const again = await f.lifecycle.archive(own.id, {
    revision: f.store.getAssistant(own.id).revision,
  });
  f.users.known.delete("anna");
  await assert.rejects(f.lifecycle.restore(own.id, { revision: again.revision }), {
    status: 409,
    key: "userAgentUserGone",
  });
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
  // An agent answering people on its own Telegram bot is disconnected first.
  f.assistants.telegramSenders.connected = (id) => id === agent.id;
  await assert.rejects(f.lifecycle.delete(agent.id, { name: agent.name }), {
    status: 409,
    key: "telegramSendersArchive",
  });
  f.assistants.telegramSenders.connected = () => false;
  // OpenClaw removes the agent and its jobs: the Gateway must run.
  f.assistants.runtime.client.ready = false;
  await assert.rejects(f.lifecycle.delete(agent.id, { name: agent.name }), {
    status: 503,
    key: "agentDeleteService",
  });
  assert.equal(f.store.storedAssistant(agent.id).deletingAt, undefined);
});

// Every file below the data directory, as relative paths.
function tree(dir, relative = "") {
  return fs
    .readdirSync(path.join(dir, relative), { withFileTypes: true })
    .flatMap((e) => {
      const name = path.join(relative, e.name);
      return e.isDirectory() ? [name + "/", ...tree(dir, name)] : [name];
    });
}

test("delete removes every store of the agent and keeps everything else", async (t) => {
  const f = lifecycleFixture(t);
  // The schemas the purge expects are the real ones (agent-deletion.js agentTables).
  for (const table of agentTables)
    assert.ok(
      f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table),
      table,
    );
  const other = f.populated("Other");
  const { agent } = f.populated();
  const id = agent.id;
  // Another agent's team policy and lead shares stay.
  const policy = f.service.store.policy(other.agent.id);
  f.service.store.savePolicy(other.agent.id, { autonomous: false }, policy.revision);
  const archived = await f.lifecycle.archive(id, { revision: agent.revision });
  assert.ok(archived.archivedAt);
  assert.deepEqual(await f.lifecycle.deletion(id), {
    id,
    name: "Helper",
    counts: { chats: 1, routines: 2, memoryFiles: 2, workspaceFiles: 1, members: 0 },
  });
  const full = f.remains(id);
  assert.equal(full.files.length, 6);
  for (const key of [
    "attachments",
    "notes",
    "routineResults",
    "hookEvents",
    "leadShares",
    "followUps",
  ])
    assert.ok(full.rows[key], key);
  const otherBefore = f.remains(other.agent.id);
  const before = tree(f.dataDir);
  const auditBefore = f.audit.length;
  await f.lifecycle.delete(id, { name: "Helper" });
  assert.deepEqual(f.remains(id), { files: [], rows: {} });
  // Native: OpenClaw's own delete takes its entry and every cron job of the agent;
  // AgentPier deletes the files itself, never into a trash folder.
  assert.deepEqual(f.deletedAgents, [
    { agentId: agent.runtimeAgentId, deleteFiles: false },
  ]);
  assert.deepEqual(f.removedJobs.sort(), [`job-${id}`, `own-${id}`]);
  assert.deepEqual(f.forgotten, [`channel-${id}`]);
  assert.deepEqual(f.unbound, [["agent", id, []]]);
  // Kept: everything outside the agent's own folders, project memory and pipeline
  // runs among them, and every row of the other agent.
  const after = new Set(tree(f.dataDir));
  const own = [id, agent.runtimeAgentId, `agent-${id}`];
  const lost = before.filter(
    (file) => !after.has(file) && !own.some((part) => file.includes(part)),
  );
  assert.deepEqual(
    lost.filter((file) => !/-(wal|shm|journal)$/.test(file)),
    [],
  );
  assert.ok(before.some((file) => file.startsWith("pipeline-runs/")));
  assert.ok(before.some((file) => file.startsWith("memory")));
  assert.deepEqual(f.remains(other.agent.id), otherBefore);
  assert.ok(f.service.store.find(`policy:${other.agent.id}`));
  assert.ok(f.roster.has(other.agent.runtimeAgentId));
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

test("the owner deletes a user's agent with her chats on it", async (t) => {
  const f = lifecycleFixture(t);
  const { agent, chat } = f.populated("Anna's agent", {
    userAccess: { mode: "own", members: [{ userId: "anna", level: "extended" }] },
  });
  assert.equal(f.store.storedConversation(chat.id).userId, "anna");
  await f.lifecycle.archive(agent.id, { revision: agent.revision });
  await f.lifecycle.delete(agent.id, { name: "Anna's agent" });
  assert.deepEqual(f.remains(agent.id), { files: [], rows: {} });
});
