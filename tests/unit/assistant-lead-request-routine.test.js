import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import {
  callerOf,
  publicRequest,
  requestCaps,
  taskWritable,
} from "../../server/features/assistants/lead-request-store.js";
import { autonomousCaps } from "../../server/features/assistants/team-policy.js";

// A lead with a permanent "Scout" and a temporary "Writer"; its routine "Morning
// check" runs in its own run session, without any ledger attempt.
function setup(t, usage) {
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const [scout, writer] = f.team(own, { count: 2, names: ["Scout", "Writer"] });
  f.promote(scout);
  if (usage) {
    const policy = f.teams.policy(own.assistant.id);
    f.teams.savePolicy(own.assistant.id, { usage }, policy.revision);
  }
  let runs = 0;
  const run = (name = "Morning check") => ({
    bindingId: "binding-1",
    name,
    conversationId: own.chat.id,
    sessionKey: `agent:lead:cron:job-1:run:r${runs++}`,
  });
  const request = (member, { type = "task", routine = run(), input = {} } = {}) => {
    const r = f.requests.create({
      type,
      routine,
      operationId: crypto.randomUUID(),
      input: {
        memberId: member.id,
        [type === "task" ? "task" : "question"]: "Review the budget",
        ...input,
      },
    });
    return r;
  };
  const finish = (r) => f.teams.write(f.teams.get(r.id), { phase: "completed" });
  return { ...f, own, scout, writer, run, request, finish };
}

test("a routine asks any reachable member and is recorded as its origin", (t) => {
  const f = setup(t);
  const q = f.request(f.writer, { type: "question" });
  assert.equal(q.parentAssistantId, f.own.assistant.id);
  assert.equal(q.parentConversationId, f.own.chat.id);
  assert.equal(q.parentRequestId, null);
  assert.equal(q.parentAttemptId, null);
  assert.deepEqual(q.origin, {
    kind: "routine",
    bindingId: "binding-1",
    name: "Morning check",
  });
  assert.equal(publicRequest(q).routine, "Morning check");
  assert.equal(publicRequest(q).writeAllowed, false);
});

test("a task a routine delegates never writes, whatever the lead claims", (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    const f = setup(t, usage);
    const r = f.request(f.scout, {
      input: {
        ownerRequested: true,
        ownerRequestQuote: "Review the budget",
      },
    });
    assert.equal(r.writeAllowed, false, usage);
    assert.equal(r.ownerProof, null, usage);
    assert.equal(r.autonomous, undefined, usage);
    // At the autonomous level the lead's own request counts against its budget.
    assert.equal(!!r.selfInitiated, usage === "autonomous", usage);
  }
});

test("a routine the owner lets delegate writing tasks starts tasks that may write", (t) => {
  const f = setup(t);
  const marked = f.request(f.scout, { routine: { ...f.run(), delegateWrites: true } });
  assert.equal(marked.writeAllowed, true);
  assert.equal(marked.routineWrites, true);
  assert.equal(marked.ownerProof, null);
  assert.equal(
    marked.origin.delegateWrites,
    true,
    "recorded as the owner's standing instruction",
  );
  assert.equal(publicRequest(marked).routineWrites, true);
  assert.equal(taskWritable(marked), true);
  f.finish(marked);
  // Unmarked routines stay read-only; a question never writes.
  const plain = f.request(f.scout);
  assert.equal(plain.writeAllowed, false);
  assert.equal(taskWritable(plain), false);
  const question = f.request(f.writer, {
    type: "question",
    routine: { ...f.run(), delegateWrites: true },
  });
  assert.equal(question.writeAllowed, false);
  assert.equal(taskWritable({ ...marked, cancelRequested: true }), false);
});

test("only the routine binding's own switch reaches a request, never the lead", () => {
  const binding = (flag) => ({
    id: "b1",
    definition: { name: "Nightly" },
    ...(flag === undefined ? {} : { routineDelegateWrites: flag }),
  });
  const caller = (flag) =>
    callerOf({
      attemptId: null,
      routine: { binding: binding(flag), conversation: { id: "c1" } },
      sessionKey: "agent:a:cron:j:run:1",
    }).routine.delegateWrites;
  assert.equal(caller(true), true);
  assert.equal(caller(false), false);
  assert.equal(caller(undefined), false);
  assert.equal(caller("yes"), false);
});

test("a routine reaches neither archived nor temporary members for tasks", (t) => {
  const f = setup(t);
  assert.throws(() => f.request(f.writer), { key: "memberRequestNotPermanent" });
  f.archive(f.writer);
  assert.throws(() => f.request(f.writer, { type: "question" }), { status: 404 });
});

test("a routine of an archived lead or of a member is refused", (t) => {
  const f = setup(t);
  const memberChat = f.teams.member(f.scout.id).conversationId;
  assert.throws(
    () =>
      f.request(f.writer, {
        type: "question",
        routine: { ...f.run(), conversationId: memberChat },
      }),
    { status: 403 },
  );
  const lead = f.store.getAssistant(f.own.assistant.id);
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...lead, archivedAt: new Date().toISOString() }), lead.id);
  assert.throws(() => f.request(f.writer, { type: "question" }), { status: 403 });
});

test("a routine run's requests are idempotent and capped per run", (t) => {
  const saved = { ...requestCaps };
  Object.assign(requestCaps, { perMinute: 1000 });
  t.after(() => Object.assign(requestCaps, saved));
  const f = setup(t);
  const routine = f.run();
  const operationId = crypto.randomUUID();
  const make = () =>
    f.requests.create({
      type: "question",
      routine,
      operationId,
      input: { memberId: f.writer.id, question: "Status?" },
    });
  assert.equal(make().id, make().id);
  for (let n = 1; n < requestCaps.perTurn; n++)
    f.request(f.writer, { type: "question", routine });
  assert.throws(() => f.request(f.writer, { type: "question", routine }), {
    key: "memberRequestRate",
  });
  // The next run starts with a fresh budget.
  assert.ok(f.request(f.writer, { type: "question" }).id);
});

test("an autonomous lead's routine requests count against the autonomous caps", (t) => {
  const saved = { ...requestCaps };
  Object.assign(requestCaps, { perMinute: 1000 });
  t.after(() => Object.assign(requestCaps, saved));
  const f = setup(t, "autonomous");
  const routine = f.run();
  for (let n = 0; n < autonomousCaps.perTurn; n++)
    f.request(f.writer, { type: "question", routine });
  assert.throws(() => f.request(f.writer, { type: "question", routine }), {
    key: "memberRequestAutonomousLimit",
  });
});
