import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { peers } from "../helpers/peer-request-fixture.js";
import { leadShareFixture } from "../helpers/lead-share-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { workspaceContext } from "../../server/features/assistants/workspace-calls.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import {
  applyTaskShare,
  taskShare,
} from "../../server/features/assistants/lead-share-input.js";

const code = (key) => (error) => toolError(error).code === key;

// A second permanent member "Learning" of the share fixture's lead, with its own chat.
async function sibling(f) {
  // The fixture's team is over; the lead may propose its next one.
  f.teams.write(f.teams.get(f.member.teamId), { phase: "completed" });
  const lead = await f.turn(f.channel.conversationId, {
    kind: "owner",
    teamAllowed: true,
  });
  const proposed = f.teams.propose({
    operationId: "learning-team",
    parentAttemptId: lead.attemptId,
    objective: "Learn",
    members: [{ name: "Learning", role: "Learn", assignment: "Learn the site" }],
  });
  f.assistants.ledger.transition(lead.attemptId, "completed");
  f.teams.reserve(proposed.id);
  let member = f.teams.members(proposed.id)[0];
  const chat = f.store.saveConversation({
    assistantId: member.assistantId,
    runtimeSessionKey: "learning-session",
  });
  member = f.teams.write(member, { conversationId: chat.id, phase: "completed" });
  f.teams.promote(member.id, member.revision);
  return { member: f.teams.member(member.id), chat };
}

// A peer task from `from` for the fixture's member Scout, running in its own turn.
async function peerTask(f, from, patch = {}) {
  const id = randomUUID();
  f.teams.insert({
    id,
    kind: "lead-request",
    revision: 1,
    type: "task",
    parentAssistantId: f.lead,
    parentConversationId: f.channel.conversationId,
    memberId: f.member.id,
    memberAssistantId: f.member.assistantId,
    memberName: "Scout",
    fromMemberId: from.member.id,
    fromAssistantId: from.member.assistantId,
    fromName: "Learning",
    fromConversationId: from.chat.id,
    resultTo: "me",
    text: "Check the site",
    origin: { kind: "peer", fromMemberId: from.member.id },
    ownerProof: null,
    writeAllowed: false,
    phase: "running",
    createdAt: new Date().toISOString(),
    ...patch,
  });
  const inv = await f.turn(
    f.memberChat.id,
    { kind: "lead-request", requestId: id, peer: true, fromName: "Learning" },
    `lead-request:${id}`,
  );
  f.teams.write(f.teams.get(id), { attemptId: inv.attemptId });
  return { id, inv };
}

test("a peer task uses the receiver's own grants and standing shares, never a task's share", async (t) => {
  const f = await leadShareFixture(t);
  const from = await sibling(f);
  const project = f.folderProject.id;
  // The sender holds a share of the lead for one of its own tasks.
  const share = taskShare(f.workflows, f.store.getAssistant(f.lead), from.member, {
    projects: { [project]: "write" },
  });
  const senderTask = randomUUID();
  f.teams.insert({
    id: senderTask,
    kind: "lead-request",
    revision: 1,
    type: "task",
    parentAssistantId: f.lead,
    memberId: from.member.id,
    memberAssistantId: from.member.assistantId,
    phase: "running",
    createdAt: new Date().toISOString(),
  });
  applyTaskShare(share, f.teams.get(senderTask), await f.leadTurn());
  const readOnly = await peerTask(f, from);
  await assert.rejects(
    f.call(readOnly.inv, { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  // A standing share of the receiver applies, read-only in a read-only task.
  await f.share({ grants: { projects: { [project]: "write" } } });
  assert.equal(
    (await f.call(readOnly.inv, { action: "file_read", path: "README.md" })).access,
    "read",
  );
  await assert.rejects(
    f.call(readOnly.inv, { action: "file_write", path: "x.md", content: "x" }),
    code("PROJECT_READ_ONLY"),
  );
  await assert.rejects(
    f.call(readOnly.inv, { action: "memory_search" }),
    code("FORBIDDEN"),
  );
  f.teams.write(f.teams.get(readOnly.id), { phase: "completed" });
  // A writable one writes at the receiver's own level, named as a peer request.
  const writable = await peerTask(f, from, {
    writeAllowed: true,
    peerWrites: { kind: "owner", requestId: "r" },
  });
  const written = await f.call(writable.inv, {
    action: "file_write",
    path: "peer.md",
    content: "done",
  });
  assert.equal(written.created, true);
  const audit = f.audits.findLast((e) => e.details?.kind === "project-file");
  assert.equal(audit.resourceId, f.member.assistantId);
  assert.equal(audit.details.via, "peer-request");
  assert.equal(audit.details.leadRequestId, writable.id);
  f.teams.write(f.teams.get(writable.id), { phase: "completed" });
  // Without the share, the receiver's own owner-granted folder is its own access.
  for (const row of f.shares.rows(f.member.assistantId)) f.shares.remove(row.id);
  f.workflows.access.save(
    f.member.assistantId,
    { ...f.policy, projectIds: [project], projectFiles: { [project]: "read" } },
    f.workflows.access.get(f.member.assistantId).revision,
  );
  const own = await peerTask(f, from);
  assert.equal((await f.call(own.inv, { action: "files_list" })).access, "read");
});

test("a peer task a writable lead task started reaches only the lead's standing shares", async (t) => {
  const f = await leadShareFixture(t);
  const from = await sibling(f);
  const project = f.folderProject.id;
  // The receiver holds the folder itself, as the owner granted it.
  f.workflows.access.save(
    f.member.assistantId,
    { ...f.policy, projectIds: [project], projectFiles: { [project]: "write" } },
    f.workflows.access.get(f.member.assistantId).revision,
  );
  const writes = (kind) => ({
    writeAllowed: true,
    peerWrites: {
      kind,
      ...(kind === "routine" ? { bindingId: "b" } : { requestId: "r" }),
    },
  });
  const done = (task) => f.teams.write(f.teams.get(task.id), { phase: "completed" });
  // From the lead's task: the receiver's own grant does not count, as in the lead's.
  const laundered = await peerTask(f, from, writes("lead-task"));
  await assert.rejects(
    f.call(laundered.inv, { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  assert.deepEqual((await f.call(laundered.inv, { action: "catalog" })).projects, []);
  // Only the lead's standing share, at its level.
  await f.share({ grants: { projects: { [project]: "read" } } });
  assert.equal((await f.call(laundered.inv, { action: "files_list" })).access, "read");
  done(laundered);
  // From the owner's own turn or a routine: the receiver's own grant writes.
  for (const kind of ["owner", "routine"]) {
    const task = await peerTask(f, from, writes(kind));
    assert.equal(
      (await f.call(task.inv, { action: "file_write", path: `${kind}.md`, content: "x" }))
        .created,
      true,
      kind,
    );
    done(task);
  }
  // A question (never writing, whatever turn asked it) reads the receiver's own folder.
  const question = await peerTask(f, from, { type: "question" });
  assert.equal((await f.call(question.inv, { action: "files_list" })).access, "read");
});

test("a writable peer task writes the receiver's workspace, never its memory", async (t) => {
  const f = await peers(t);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  const receiver = f.store.getAssistant(f.second.assistantId);
  const session = f.store.getConversation(f.second.conversationId).runtimeSessionKey;
  const write = (path = "notes/plan.md") =>
    bridge.toolPolicy({
      agentId: receiver.runtimeAgentId,
      sessionKey: session,
      toolName: "write",
      path,
    }).allow;
  // The owner's own turn with the sender: the task may write.
  const task = await f.service.peers.peer_delegate(f.memberTurn(f.permanent), {
    memberId: f.second.id,
    task: "Draft the plan",
  });
  assert.equal(task.mayWrite, true);
  assert.equal(f.service.requests.store.get(task.requestId).phase, "running");
  assert.equal(write(), true);
  for (const path of ["MEMORY.md", "memory/today.md"]) assert.equal(write(path), false);
  const notes = f.assistants.memoryNotes.forConversation(f.second.conversationId);
  assert.deepEqual(
    notes.map((n) => n.reason),
    ["peer-request"],
  );
  const r = f.service.requests.store.get(task.requestId);
  f.complete(r.attemptId);
  f.settle();
  await f.service.reconcile();
  // From the sender's team assignment: read-only.
  const readOnly = await f.service.peers.peer_delegate(
    f.memberTurn(f.permanent, { kind: "team-member" }),
    { memberId: f.second.id, task: "Draft the plan again" },
  );
  assert.equal(readOnly.mayWrite, false);
  assert.equal(f.service.requests.store.get(readOnly.requestId).phase, "running");
  assert.equal(write(), false);
});

test("the peer-result turn cannot write or open project folders", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  const result = await f.service.peers.peer_ask(f.memberTurn(f.permanent), {
    memberId: f.second.id,
    question: "What did you find?",
  });
  const r = f.service.requests.store.get(result.requestId);
  f.complete(r.attemptId);
  f.settle();
  await f.service.reconcile();
  const followUp = f.assistants.ledger
    .requests(f.permanent.conversationId)
    .find((x) => x.clientRequestId === `peer-request-result:${r.id}`);
  assert.ok(followUp);
  const attempt = f.assistants.ledger.pending().find((a) => a.requestId === followUp.id);
  assert.ok(attempt, "the follow-up turn runs");
  const asker = f.store.getAssistant(f.permanent.assistantId);
  const session = f.store.getConversation(f.permanent.conversationId).runtimeSessionKey;
  for (const path of ["notes/plan.md", "MEMORY.md"])
    assert.equal(
      bridge.toolPolicy({
        agentId: asker.runtimeAgentId,
        sessionKey: session,
        toolName: "write",
        path,
      }).allow,
      false,
      path,
    );
  const w = { a: f.assistants, access: { eligible: (id) => f.store.getAssistant(id) } };
  assert.throws(
    () =>
      workspaceContext(w, {
        attemptId: attempt.id,
        toolCallId: "x",
        assertCurrent() {},
      }),
    { status: 403 },
  );
});

test("a peer request records whether the lead started the sender's turn", async (t) => {
  const f = await peers(t);
  f.service.requests.waitMs = 0;
  let now = Date.now();
  const scope = (inv, type = "task") => {
    now += 3600000;
    const r = (type === "task" ? f.peerDelegate : f.peerAsk)(inv, f.second, {}, now);
    f.finish(r);
    return r.leadScope;
  };
  // The owner's own turn with the sender keeps the receiver's own access.
  assert.equal(scope(f.memberTurn(f.permanent)), false);
  assert.equal(scope(f.memberTurn(f.permanent), "question"), false);
  // A team assignment, a lead question and a lead task are the lead's.
  const assignment = { kind: "team-member", teamId: f.team.id, memberId: f.permanent.id };
  assert.equal(scope(f.memberTurn(f.permanent, assignment), "question"), true);
  f.settle();
  const asked = await f.service.ask(f.turn(), {
    memberId: f.permanent.id,
    question: "What is the budget?",
  });
  const q = f.service.requests.store.get(asked.requestId);
  const inv = (r, id) => ({ attemptId: r.attemptId, toolCallId: id, assertCurrent() {} });
  assert.equal(scope(inv(q, "q"), "question"), true);
  f.finish(q);
  f.settle();
  const tasked = await f.service.delegate(f.turn(), {
    memberId: f.permanent.id,
    task: "Draft the plan",
  });
  const task = f.service.requests.store.get(tasked.requestId);
  assert.equal(scope(inv(task, "t")), true);
  f.finish(task);
  // A routine is the lead's when the lead set it up, also an autonomous one.
  f.assistants.routines = { writable: () => true };
  const run = (key, binding) => ({
    attemptId: null,
    toolCallId: key,
    sessionKey: `agent:x:cron:job-1:run:${key}`,
    routine: {
      binding: { id: key, assistantId: f.permanent.assistantId, ...binding },
      conversation: f.store.getConversation(f.permanent.conversationId),
    },
    assertCurrent() {},
  });
  assert.equal(scope(run("owner-routine", {})), false);
  assert.equal(scope(run("lead-routine", { createdBy: "lead" })), true);
});

test("a peer chain the lead started never reaches the receiver's own folders", async (t) => {
  const f = await leadShareFixture(t);
  const from = await sibling(f);
  const project = f.folderProject.id;
  f.workflows.access.save(
    f.member.assistantId,
    { ...f.policy, projectIds: [project], projectFiles: { [project]: "write" } },
    f.workflows.access.get(f.member.assistantId).revision,
  );
  const done = (task) => f.teams.write(f.teams.get(task.id), { phase: "completed" });
  // A writable task from the lead's (autonomous) routine cannot write the folder.
  const routine = await peerTask(f, from, {
    writeAllowed: true,
    peerWrites: { kind: "routine", bindingId: "b" },
    leadScope: true,
  });
  await assert.rejects(
    f.call(routine.inv, { action: "file_write", path: "x.md", content: "x" }),
    code("PROJECT_NOT_GRANTED"),
  );
  done(routine);
  // A question from a lead's question or assignment cannot read it either.
  const question = await peerTask(f, from, { type: "question", leadScope: true });
  await assert.rejects(
    f.call(question.inv, { action: "files_list" }),
    code("PROJECT_NOT_GRANTED"),
  );
  assert.deepEqual((await f.call(question.inv, { action: "catalog" })).projects, []);
  done(question);
  // The owner's own turn keeps the receiver's own grant, read-only in a question.
  const own = await peerTask(f, from, { type: "question", leadScope: false });
  assert.equal((await f.call(own.inv, { action: "files_list" })).access, "read");
});
