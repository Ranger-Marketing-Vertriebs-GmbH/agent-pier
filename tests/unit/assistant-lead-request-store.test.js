import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import { ownerQuote } from "../../server/features/assistants/lead-request-store.js";

const ownerText = "Please ask the researcher what the budget is";
const quote = "ask the researcher what the budget is";

function setup(t) {
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const [temporary, permanent] = f.team(own, { count: 3 });
  f.promote(permanent);
  const other = f.lead("Other lead");
  const [foreign] = f.team(other, { count: 1 });
  const ask = (
    member,
    { context, text = ownerText, claim = true, type = "question" } = {},
  ) => {
    const attempt = f.turn(own.chat, text, context);
    return f.requests.create({
      type,
      attemptId: attempt.id,
      operationId: crypto.randomUUID(),
      input: {
        memberId: member.id,
        [type === "task" ? "task" : "question"]: "What is the budget?",
        ...(claim ? { ownerRequested: true, ownerRequestQuote: quote } : {}),
      },
    });
  };
  return { ...f, own, other, temporary, permanent, foreign, ask };
}

test("a lead reaches only its own members that are not archived", (t) => {
  const f = setup(t);
  assert.equal(f.ask(f.temporary).phase, "queued");
  assert.equal(f.ask(f.permanent).phase, "queued");
  assert.throws(() => f.ask(f.foreign), { status: 404 });
  const [, , third] = f.teams
    .members()
    .filter((m) => m.parentAssistantId === f.own.assistant.id);
  f.archive(third);
  assert.throws(() => f.ask(third), { status: 404 });
  assert.throws(() => f.ask({ id: "missing" }), { status: 404 });
});

test("tasks go only to permanent members, one open task at a time", (t) => {
  const f = setup(t);
  assert.throws(() => f.ask(f.temporary, { type: "task" }), {
    status: 409,
    key: "memberRequestNotPermanent",
  });
  const task = f.ask(f.permanent, { type: "task" });
  assert.equal(task.phase, "queued");
  assert.throws(() => f.ask(f.permanent, { type: "task" }), {
    status: 409,
    key: "memberRequestOpenTask",
  });
  // Questions may still wait beside the open task.
  assert.equal(f.ask(f.permanent).phase, "queued");
  f.teams.write(f.teams.get(task.id), { phase: "completed" });
  assert.equal(f.ask(f.permanent, { type: "task" }).phase, "queued");
});

test("running and finished members can be asked; their turn waits until they are free", (t) => {
  const f = setup(t);
  const running = f.teams.write(f.teams.member(f.temporary.id), { phase: "running" });
  assert.equal(f.ask(running).phase, "queued");
  assert.equal(f.ask(f.permanent).phase, "queued");
});

test("only an explicit owner request with its own words runs without approval", (t) => {
  const f = setup(t);
  const cases = [
    [{ kind: "owner" }, true, "queued"],
    [{ kind: "telegram", channelId: "c", chatId: "1", userId: "1" }, true, "queued"],
    [{ kind: "owner" }, false, "awaiting_approval"],
    [{ kind: "owner", forwarded: true }, true, "awaiting_approval"],
    [{ kind: "telegram", forwarded: true }, true, "awaiting_approval"],
    [{ kind: "team-result" }, true, "awaiting_approval"],
    [{ kind: "member-result" }, true, "awaiting_approval"],
    [{ kind: "reminder" }, true, "awaiting_approval"],
    [{ kind: "unknown" }, true, "awaiting_approval"],
  ];
  for (const [context, claim, phase] of cases)
    assert.equal(
      f.ask(f.temporary, { context, claim }).phase,
      phase,
      JSON.stringify(context),
    );
  // A quote the owner never wrote proves nothing.
  assert.equal(
    f.ask(f.temporary, { text: "Hello there, how are you" }).phase,
    "awaiting_approval",
  );
});

test("standing team autonomy covers owner turns, never agent-initiated ones", (t) => {
  const f = setup(t);
  f.teams.savePolicy(f.own.assistant.id, { autonomous: true }, 1);
  assert.equal(f.ask(f.temporary, { claim: false }).authorization.kind, "standing");
  assert.equal(
    f.ask(f.temporary, { claim: false, context: { kind: "team-result" } }).phase,
    "awaiting_approval",
  );
});

test("members cannot ask or delegate further", (t) => {
  const f = setup(t);
  const member = f.store.getAssistant(f.permanent.assistantId);
  const chat = f.store.getConversation(f.permanent.conversationId);
  assert.equal(member.teamMemberId, f.permanent.id);
  const attempt = f.turn(chat, ownerText);
  assert.throws(
    () =>
      f.requests.create({
        type: "question",
        attemptId: attempt.id,
        operationId: "chain",
        input: { memberId: f.temporary.id, question: "Anything?" },
      }),
    { status: 403 },
  );
});

test("an archived lead cannot ask its members", (t) => {
  const f = setup(t);
  const lead = f.store.getAssistant(f.own.assistant.id);
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...lead, archivedAt: new Date().toISOString() }), lead.id);
  assert.throws(() => f.ask(f.temporary), { status: 403 });
});

test("replays return the same request and inputs are length-limited", (t) => {
  const f = setup(t);
  const attempt = f.turn(f.own.chat, ownerText);
  const input = { memberId: f.temporary.id, question: "Budget?" };
  const create = (value, operationId = "same") =>
    f.requests.create({
      type: "question",
      attemptId: attempt.id,
      operationId,
      input: value,
    });
  const first = create(input);
  assert.equal(create(input).id, first.id);
  assert.throws(() => create({ ...input, question: "Other" }), { status: 409 });
  assert.throws(() => create({ ...input, question: "x".repeat(4001) }, "long"), {
    status: 400,
  });
  assert.throws(() => create({ ...input, extra: true }, "extra"), { status: 400 });
  assert.throws(
    () =>
      f.requests.create({
        type: "task",
        attemptId: attempt.id,
        operationId: "task",
        input: { memberId: f.permanent.id, task: "x".repeat(8193) },
      }),
    { status: 400 },
  );
});

test("owner decisions follow the team rules, including the Telegram origin", (t) => {
  const f = setup(t);
  const origin = { kind: "telegram", channelId: "c", chatId: "1", userId: "1" };
  const r = f.ask(f.temporary, { context: origin, claim: false });
  assert.equal(r.phase, "awaiting_approval");
  assert.throws(
    () =>
      f.requests.decide(
        r.id,
        { revision: r.revision, decision: "approve" },
        { kind: "model" },
      ),
    {
      status: 403,
    },
  );
  assert.throws(
    () =>
      f.requests.decide(
        r.id,
        { revision: r.revision, decision: "approve" },
        { ...origin, chatId: "2" },
      ),
    { status: 403 },
  );
  const approved = f.requests.decide(
    r.id,
    { revision: r.revision, decision: "approve" },
    origin,
  );
  assert.equal(approved.phase, "queued");
  assert.throws(
    () => f.requests.decide(r.id, { revision: r.revision, decision: "approve" }, origin),
    { status: 409 },
  );
  const later = f.ask(f.temporary, { claim: false });
  f.archive(f.teams.member(f.temporary.id));
  assert.throws(
    () =>
      f.requests.decide(
        later.id,
        { revision: later.revision, decision: "approve" },
        { kind: "owner" },
      ),
    { status: 404 },
  );
  const declined = f.requests.decide(
    later.id,
    { revision: later.revision, decision: "decline" },
    { kind: "owner" },
  );
  assert.equal(declined.phase, "declined");
});

test("a lead archives only its own finished temporary members", (t) => {
  const f = setup(t);
  const ownMembers = f.teams
    .members()
    .filter((m) => m.parentAssistantId === f.own.assistant.id);
  const third = ownMembers[2];
  assert.equal(f.requests.archivable(f.own.assistant.id, [f.temporary.id]).length, 1);
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [f.permanent.id]), {
    status: 409,
  });
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [f.foreign.id]), {
    status: 404,
  });
  f.teams.write(f.teams.member(third.id), { phase: "running" });
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [third.id]), {
    status: 409,
  });
  f.ask(f.temporary);
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [f.temporary.id]), {
    status: 409,
  });
  assert.throws(() => f.requests.archivable(f.own.assistant.id, []), { status: 400 });
  assert.throws(
    () => f.requests.archivable(f.own.assistant.id, [f.temporary.id, f.temporary.id]),
    { status: 400 },
  );
});

test("an owner quote needs three words found in the owner's text", () => {
  assert.equal(ownerQuote("ask the  Researcher", "Please ask the researcher now"), true);
  assert.equal(ownerQuote("ask researcher", "Please ask researcher now"), false);
  assert.equal(ownerQuote("ask the boss", "Please ask the researcher now"), false);
  assert.equal(ownerQuote("x ".repeat(200), "x ".repeat(400)), false);
});
