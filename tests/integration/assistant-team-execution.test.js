import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
test("four members run concurrently, host capacity is shared, and no automatic second turn starts", async (t) => {
  const f = teamFixture(t),
    a = await f.proposal(),
    b = await f.proposal(),
    c = await f.proposal();
  await f.service.reconcile();
  assert.equal(f.runs.size, 8);
  assert.equal(f.service.store.get(a.team.id).phase, "running");
  assert.ok(f.service.store.members(a.team.id).every((m) => m.phase === "running"));
  assert.ok(f.service.store.members(b.team.id).every((m) => m.phase === "running"));
  assert.ok(f.service.store.members(c.team.id).every((m) => m.phase === "queued"));
  await f.service.reconcile();
  assert.equal(f.runs.size, 8);
  const member = f.service.store.members(a.team.id)[0];
  f.complete(member.attemptId);
  await f.service.reconcile();
  assert.equal(f.runs.size, 9);
  assert.equal(f.service.store.member(member.id).phase, "completed");
});
test("pending approval allocates nothing and approval admits the stored snapshot", async (t) => {
  const f = teamFixture(t),
    { team, parent } = await f.proposal({ allowed: false });
  await f.service.reconcile();
  assert.equal(f.runs.size, 0);
  assert.equal(f.service.store.members(team.id).length, 0);
  f.store.updateAssistant(parent.id, { instructions: "Changed" }, 1);
  await f.service.decide(
    team.id,
    { revision: team.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.service.reconcile();
  assert.equal(f.runs.size, 4);
  assert.ok(
    f.service.store
      .members(team.id)
      .every((m) => f.store.getAssistant(m.id).instructions.includes("Original")),
  );
});
test("deadline requests stop without claiming terminal outcome or releasing a slot", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal();
  await f.service.reconcile();
  f.clock(600001);
  await f.service.reconcile();
  assert.ok(f.service.store.members(team.id).every((m) => m.phase === "stopping"));
  assert.equal(f.calls.filter((c) => c.method === "sessions.abort").length, 4);
  await f.service.reconcile();
  assert.equal(f.runs.size, 4);
  assert.throws(() => f.service.store.promote(team.memberIds[0], 1));
});
test("internal results cannot mint standing or one-shot permission", async (t) => {
  const f = teamFixture(t),
    { parent, chat, attempt } = await f.proposal({ allowed: false });
  const old = f.service.store.list()[0];
  await f.service.decide(
    old.id,
    { revision: old.revision, decision: "decline" },
    { kind: "owner" },
  );
  f.assistants.ledger.transition(attempt.id, "completed");
  f.service.store.savePolicy(parent.id, { autonomous: true }, 1);
  const sent = await f.assistants.send(
    chat.id,
    { clientRequestId: "internal", text: "/team Internal", teamAllowed: true },
    { kind: "team-result" },
  );
  assert.equal(f.service.store.context(sent.request.id).teamAllowed, false);
  const result = await f.service.propose(
    { attemptId: sent.attempt.id, toolCallId: "internal", assertCurrent() {} },
    {
      objective: "Do not auto-admit",
      members: [{ name: "A", role: "R", assignment: "Task" }],
    },
  );
  assert.equal(result.phase, "awaiting_approval");
});
test("owner messages cannot bypass reserved member execution or archive guards", async (t) => {
  const f = teamFixture(t),
    { team } = await f.proposal({ count: 1 });
  await assert.rejects(f.assistants.openConversation(team.memberIds[0]), { status: 409 });
  await f.service.reconcile();
  const m = f.service.store.members(team.id)[0];
  await assert.rejects(
    f.assistants.send(m.conversationId, { clientRequestId: "manual", text: "Interrupt" }),
    { status: 409 },
  );
  f.complete(m.attemptId);
  await f.service.reconcile();
  const current = f.service.store.member(m.id);
  f.service.store.archive(m.id, current.revision);
  await assert.rejects(
    f.assistants.send(m.conversationId, { clientRequestId: "archived", text: "Hello" }),
    { status: 409 },
  );
});
test("a plain-language owner request starts one team without changing the standing policy", async (t) => {
  const f = teamFixture(t),
    parent = f.store.createAssistant({
      name: "Parent",
      instructions: "Original",
      model: { connectionId: "c", modelId: "m" },
    }),
    chat = f.store.saveConversation({
      assistantId: parent.id,
      runtimeSessionKey: "parent-plain",
    });
  const members = [{ name: "Reviewer", role: "Review", assignment: "Check notes" }];
  const turn = async (id, text, context, extra, input = {}) => {
    const sent = await f.assistants.send(
      chat.id,
      { clientRequestId: id, text, ...input },
      context,
    );
    const result = await f.service.propose(
      { attemptId: sent.attempt.id, toolCallId: id, assertCurrent() {} },
      { objective: "Release notes", members, ...extra },
    );
    const record = f.service.store.get(result.id);
    f.service.store.write(record, {
      phase: record.authorization ? "completed" : "declined",
    });
    f.assistants.ledger.transition(sent.attempt.id, "completed");
    return record;
  };
  const text = "Stell bitte ein Team zusammen, das die Release Notes prüft";
  const asked = { ownerRequestedTeam: true, ownerRequestQuote: "ein Team zusammen" };
  const team = await turn("plain", text, { kind: "owner" }, asked);
  assert.equal(team.phase, "queued");
  assert.equal(team.authorization.kind, "task");
  assert.equal(f.service.store.policy(parent.id).autonomous, false);
  assert.equal(f.service.store.policy(parent.id).revision, 1);
  const mismatch = await turn(
    "mismatch",
    text,
    { kind: "owner" },
    { ...asked, ownerRequestQuote: "baue sofort ein Team" },
  );
  assert.equal(mismatch.phase, "awaiting_approval");
  const member = await turn(
    "member",
    text,
    { kind: "team-member", teamId: "t", memberId: "m" },
    asked,
  );
  assert.equal(member.phase, "awaiting_approval");
  const command = await turn("command", "/team Review the notes", { kind: "owner" }, {});
  assert.equal(command.authorization.kind, "task");
  const checkbox = await turn(
    "checkbox",
    "Review",
    { kind: "owner" },
    {},
    {
      teamAllowed: true,
    },
  );
  assert.equal(checkbox.authorization.kind, "task");
  await assert.rejects(
    turn("invalid", text, { kind: "owner" }, { ownerRequestedTeam: "yes" }),
    { status: 400 },
  );
});
test("a rejected owner quote never fails a proposal: the checkbox still authorizes, otherwise approval is asked", async (t) => {
  const f = teamFixture(t);
  const propose = async (allowed, ownerRequestQuote) => {
    const parent = f.store.createAssistant({
      name: "Parent",
      instructions: "Original",
      model: { connectionId: "c", modelId: "m" },
    });
    const chat = f.store.saveConversation({
      assistantId: parent.id,
      runtimeSessionKey: `parent-${parent.id}`,
    });
    const request = f.assistants.ledger.accept(chat.id, {
      clientRequestId: crypto.randomUUID(),
      text: "Get two helpers to each suggest one name for a cat.",
    });
    f.service.store.recordContext(request.id, { kind: "owner", teamAllowed: allowed });
    const attempt = f.assistants.ledger.recordAttempt(request.id);
    return f.service.propose(
      { attemptId: attempt.id, toolCallId: "call", assertCurrent() {} },
      {
        objective: "Names",
        members: [{ name: "Helper", role: "Names", assignment: "Suggest one" }],
        ownerRequestedTeam: true,
        ownerRequestQuote,
      },
    );
  };
  const checkbox = await propose(true, "x".repeat(400));
  assert.notEqual(checkbox.phase, "awaiting_approval");
  assert.equal(f.service.store.get(checkbox.id).authorization.source, "checkbox");
  for (const quote of ["", "x".repeat(400), "Get two helpers", undefined]) {
    const asked = await propose(false, quote);
    assert.equal(asked.phase, "awaiting_approval");
  }
});
