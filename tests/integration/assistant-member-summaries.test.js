import test from "node:test";
import assert from "node:assert/strict";
import { lead, until } from "../helpers/lead-request-service-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import {
  actions,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import { grantNotes } from "../../server/features/assistants/member-grant-notes.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

// A lead with a permanent member whose task chat summarises through LongChats: the
// Gateway's compactions are counted and held until released; the memory step is the
// fixture's own (`step` holds it, `memory: false` skips it).
async function setup(t, { memory = true } = {}) {
  const f = await lead(t);
  const compactions = [];
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input, options) => {
    if (method !== "sessions.compact") return call(method, input, options);
    const held = deferred();
    compactions.push({ input, release: () => held.resolve() });
    await held.promise;
    return { ok: true, compacted: true };
  };
  const long = f.assistants.longChats;
  const steps = [];
  long.memoryStep.eligible = () => memory;
  long.memoryStep.run = (conversation) => {
    const held = deferred();
    steps.push({ conversation, end: (saved = true) => held.resolve({ saved }) });
    return held.promise;
  };
  // The chat notes, as the action history keeps them.
  const reserved = [];
  f.assistants.workflows = {
    store: { reserve: (row) => reserved.push(row) },
    close() {},
  };
  const cleared = [];
  const hints = f.service.memberLongChats;
  const clear = hints.clear.bind(hints);
  hints.clear = (id) => {
    cleared.push(id);
    return clear(id);
  };
  const member = f.service.store.member(f.permanent.id);
  const taskChat = f.store.getConversation(member.conversationId);
  // A turn of the member's own task chat that has not ended.
  const memberTurn = () => {
    const request = f.assistants.ledger.accept(taskChat.id, {
      clientRequestId: crypto.randomUUID(),
      text: "Work",
    });
    f.service.store.recordContext(request.id, { kind: "owner" });
    return f.assistants.ledger.recordAttempt(request.id);
  };
  const summarise = (when, inv = f.turn(), memberId = member.id) =>
    f.service.member_summarise(inv, { memberId, when });
  return {
    ...f,
    compactions,
    steps,
    reserved,
    cleared,
    member,
    taskChat,
    memberTurn,
    summarise,
    long,
  };
}

test("now summarises an idle member's chat after its memory step", async (t) => {
  const f = await setup(t);
  const result = await f.summarise("now");
  assert.equal(result.status, "summarising");
  assert.equal(result.memberId, f.member.id);
  // The memory step runs first; the summary waits for it.
  assert.equal(f.steps.length, 1);
  assert.equal(f.steps[0].conversation.id, f.taskChat.id);
  assert.equal(f.long.phase(f.taskChat.id), "memory");
  assert.equal(f.compactions.length, 0);
  // The lead's hint for this chat is forgotten once the summary starts.
  assert.deepEqual(f.cleared, [f.taskChat.id]);
  f.steps[0].end();
  await until(() => f.compactions.length, "the compaction");
  assert.equal(f.compactions[0].input.key, f.taskChat.runtimeSessionKey);
  f.compactions[0].release();
  await until(() => !f.long.compacting(f.taskChat.id), "the summary's end");
  // One note in the member's task chat and one in the lead's chat.
  assert.deepEqual(
    f.reserved.map((r) => [r.assistantId, r.conversationId]),
    [
      [f.member.assistantId, f.taskChat.id],
      [f.parent.id, f.chat.id],
    ],
  );
  for (const row of f.reserved) {
    assert.equal(row.payload.action, "member_summarise");
    assert.equal(row.payload.when, "now");
    assert.equal(row.payload.memberName, "Member 1");
    assert.equal(row.settled, true);
    const [note] = grantNotes({ id: "a1", ...row });
    assert.equal(note.event, "member-summarise");
    assert.equal(note.when, "now");
    assert.equal(note.memberName, "Member 1");
  }
});

test("now on a busy member is refused as busy; nothing runs", async (t) => {
  const f = await setup(t);
  f.memberTurn();
  const result = await f.summarise("now");
  assert.equal(result.status, "busy");
  assert.match(result.detail, /after_task/);
  assert.equal(f.steps.length, 0);
  assert.equal(f.long.compacting(f.taskChat.id), false);
  assert.equal(f.reserved.length, 0);
});

test("after_task queues once and runs when idle, before the next lead request", async (t) => {
  const f = await setup(t, { memory: false });
  const work = f.memberTurn();
  const first = await f.summarise("after_task");
  assert.equal(first.status, "queued");
  assert.equal((await f.summarise("after_task")).status, "queued");
  assert.equal(f.service.memberSummaries.pending(f.member.id), true);
  // The lead hears no long-chat hint while the summary is pending.
  assert.equal(f.service.memberLongChats.summaryPending(f.member.id), true);
  // Noted once, in both chats.
  assert.equal(f.reserved.length, 2);
  assert.ok(f.reserved.every((r) => r.payload.when === "after_task"));
  // A task for the member waits behind its running turn.
  f.idle();
  await f.service.delegate(f.turn(), { memberId: f.member.id, task: "Draft the plan" });
  await f.service.reconcile();
  assert.equal(f.compactions.length, 0, "not while the member works");
  assert.equal(f.requests().at(-1).phase, "queued");
  f.complete(work.id);
  await f.service.reconcile();
  await until(() => f.compactions.length, "the compaction");
  assert.equal(f.service.memberSummaries.pending(f.member.id), false);
  assert.deepEqual(f.cleared, [f.taskChat.id]);
  // The summary came first: the task still waits for the chat.
  assert.equal(f.requests().at(-1).phase, "queued");
  f.compactions[0].release();
  await until(() => !f.long.compacting(f.taskChat.id), "the summary's end");
  await f.service.reconcile();
  assert.equal(f.requests().at(-1).phase, "running");
  assert.equal(f.compactions.length, 1);
});

test("owner and lead summarise at once: one summary", async (t) => {
  const f = await setup(t);
  // The owner first: the lead's call finds the summary running.
  await f.long.summarise(f.taskChat.id);
  assert.equal((await f.summarise("now")).status, "already");
  assert.equal((await f.summarise("after_task")).status, "already");
  assert.equal(f.service.memberSummaries.pending(f.member.id), false);
  f.steps[0].end();
  await until(() => f.compactions.length, "the compaction");
  f.compactions[0].release();
  await until(() => !f.long.compacting(f.taskChat.id), "the summary's end");
  // The lead first: the owner's request joins the lead's summary.
  assert.equal((await f.summarise("now")).status, "summarising");
  const owner = await f.long.summarise(f.taskChat.id);
  assert.deepEqual(owner, { compacted: false, running: true });
  assert.equal(f.steps.length, 2);
  f.steps[1].end();
  await until(() => f.compactions.length === 2, "the second compaction");
  f.compactions[1].release();
  await until(() => !f.long.compacting(f.taskChat.id), "the summary's end");
  assert.equal(f.compactions.length, 2);
  // A summary the owner starts while the lead's waits takes its place.
  f.memberTurn();
  await f.summarise("after_task");
  f.idle();
  for (const a of f.assistants.ledger.pending()) f.complete(a.id);
  await f.long.summarise(f.taskChat.id);
  assert.equal(f.service.memberSummaries.pending(f.member.id), false);
  f.steps[2].end();
  await until(() => f.compactions.length === 3, "the owner's compaction");
  f.compactions[2].release();
  await until(() => !f.long.compacting(f.taskChat.id), "the summary's end");
  await f.service.reconcile();
  assert.equal(f.steps.length, 3);
  assert.equal(f.compactions.length, 3);
});

test("a pending summary is dropped once its member is archived", async (t) => {
  const f = await setup(t);
  const work = f.memberTurn();
  await f.summarise("after_task");
  f.service.store.write(f.service.store.member(f.member.id), {
    archivedAt: new Date().toISOString(),
  });
  assert.equal(f.service.memberSummaries.pending(f.member.id), false);
  f.complete(work.id);
  await f.service.reconcile();
  assert.equal(f.steps.length, 0);
  assert.equal(f.long.compacting(f.taskChat.id), false);
  assert.equal(f.service.store.member(f.member.id).summaryAfterTask, undefined);
});

test("only a lead summarises its own members that are not archived", async (t) => {
  const f = await setup(t);
  for (const when of ["soon", undefined])
    await assert.rejects(f.summarise(when), { status: 400 });
  await assert.rejects(
    f.service.member_summarise(f.turn(), { memberId: f.member.id, when: "now", x: 1 }),
    { status: 400 },
  );
  await assert.rejects(f.summarise("now", f.turn(), "missing"), {
    key: "teamGrantMemberEnded",
  });
  // Another lead's member.
  const other = f.store.createAssistant({
    name: "Other lead",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
  });
  const otherChat = f.store.saveConversation({
    assistantId: other.id,
    runtimeSessionKey: "other-lead",
  });
  const request = f.assistants.ledger.accept(otherChat.id, {
    clientRequestId: "other",
    text: "Summarise",
  });
  const foreign = {
    attemptId: f.assistants.ledger.recordAttempt(request.id).id,
    toolCallId: "call",
    assertCurrent() {},
  };
  await assert.rejects(f.summarise("now", foreign), { key: "teamGrantMemberEnded" });
  // A member never calls it, not even on itself.
  f.idle();
  const memberInv = {
    attemptId: f.memberTurn().id,
    toolCallId: "call",
    assertCurrent() {},
  };
  await assert.rejects(f.summarise("now", memberInv), { status: 403 });
  for (const a of f.assistants.ledger.pending()) f.complete(a.id);
  // An archived member.
  f.service.store.write(f.service.store.member(f.member.id), {
    archivedAt: new Date().toISOString(),
  });
  await assert.rejects(f.summarise("now"), { key: "teamGrantMemberEnded" });
  assert.equal(f.steps.length, 0);
});

test("the bridge serves the tool to a lead, also in its long-chat hint turn", async (t) => {
  const f = await setup(t);
  assert.equal(actions.has("member_summarise"), true);
  // Never in a routine's own run (as member_update).
  assert.equal(routineActions.has("member_summarise"), false);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  f.idle();
  f.turn("Note from AgentPier", { kind: "member-long-chat", memberId: f.member.id });
  const { ticket } = bridge.prepare({
    agentId: f.parent.runtimeAgentId,
    sessionKey: f.chat.runtimeSessionKey,
    toolCallId: "summarise",
    action: "member_summarise",
  });
  const result = await bridge.invoke({
    ticket,
    action: "member_summarise",
    input: { memberId: f.member.id, when: "after_task" },
  });
  assert.equal(result.status, "queued");
});
