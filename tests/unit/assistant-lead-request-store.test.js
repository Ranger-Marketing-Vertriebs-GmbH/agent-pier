import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import {
  ownerQuote,
  requestCaps,
} from "../../server/features/assistants/lead-request-store.js";
import { profileTools } from "../../server/features/assistants/native-capabilities.js";

// The owner's own words for one member: "Please ask Scout what the budget is".
const said = (name) => `Please ask ${name} what the budget is`;
const quoted = (name) => `ask ${name} what the budget is`;

function setup(t, { caps = { perMinute: 1000 } } = {}) {
  const saved = { ...requestCaps };
  Object.assign(requestCaps, caps);
  t.after(() => Object.assign(requestCaps, saved));
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const [temporary, permanent, third] = f.team(own, {
    count: 3,
    names: ["Researcher", "Scout", "Writer"],
  });
  f.promote(permanent);
  const other = f.lead("Other lead");
  const [foreign] = f.team(other, { count: 1, names: ["Scout"] });
  const name = (member) => f.store.getAssistant(member.assistantId).name;
  // One owner turn (or `attempt`) with a request for `member`.
  const ask = (
    member,
    {
      context,
      text = said(name(member)),
      quote = quoted(name(member)),
      claim = true,
      type = "question",
      attempt = f.turn(own.chat, text, context),
    } = {},
  ) =>
    f.requests.create({
      type,
      attemptId: attempt.id,
      operationId: crypto.randomUUID(),
      input: {
        memberId: member.id,
        [type === "task" ? "task" : "question"]: "What is the budget?",
        ...(claim ? { ownerRequested: true, ownerRequestQuote: quote } : {}),
      },
    });
  return { ...f, own, other, temporary, permanent, third, foreign, ask };
}

test("a lead reaches only its own members that are not archived", (t) => {
  const f = setup(t);
  assert.equal(f.ask(f.temporary).phase, "queued");
  assert.equal(f.ask(f.permanent).phase, "queued");
  assert.throws(() => f.ask(f.foreign), { status: 404 });
  f.archive(f.third);
  assert.throws(() => f.ask(f.third), { status: 404 });
  assert.throws(() => f.ask({ id: "missing", assistantId: f.third.assistantId }), {
    status: 404,
  });
});

test("members of an archived team and archived agents cannot be reached", (t) => {
  const f = setup(t);
  // The agent archived while its member record is not.
  const agent = f.store.getAssistant(f.permanent.assistantId);
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify({ ...agent, archivedAt: new Date().toISOString() }), agent.id);
  assert.throws(() => f.ask(f.permanent), { status: 404 });
  // The whole team archived at once.
  const team = f.teams.get(f.temporary.teamId);
  f.teams.archive(team.id, team.revision);
  assert.throws(() => f.ask(f.temporary), { status: 404 });
});

test("tasks go only to permanent members, one open task at a time", (t) => {
  const f = setup(t);
  assert.throws(() => f.ask(f.temporary, { type: "task" }), {
    status: 409,
    key: "memberRequestNotPermanent",
  });
  const task = f.ask(f.permanent, { type: "task" });
  assert.equal(task.phase, "queued");
  assert.equal(task.writeAllowed, true);
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

test("only an owner turn's own words for the member skip the approval", (t) => {
  const f = setup(t);
  const telegram = { kind: "telegram", channelId: "c", chatId: "1", userId: "1" };
  const cases = [
    ["owner", {}, "queued"],
    ["Telegram owner", { context: telegram }, "queued"],
    ["no claim", { claim: false }, "awaiting_approval"],
    ["forwarded", { context: { kind: "owner", forwarded: true } }, "awaiting_approval"],
    [
      "forwarded Telegram",
      { context: { ...telegram, forwarded: true } },
      "awaiting_approval",
    ],
    ["team result", { context: { kind: "team-result" } }, "awaiting_approval"],
    ["member result", { context: { kind: "member-result" } }, "awaiting_approval"],
    ["reminder", { context: { kind: "reminder" } }, "awaiting_approval"],
    ["unknown", { context: { kind: "unknown" } }, "awaiting_approval"],
    // Three unrelated words of the owner's own message (C1).
    [
      "unrelated words",
      {
        text: "Summarize https://example.org/post for me",
        quote: "Summarize https://example.org/post for",
      },
      "awaiting_approval",
    ],
    [
      "quote the owner never wrote",
      { text: "Hello there, how are you" },
      "awaiting_approval",
    ],
    // Named, but no ask or delegate cue.
    [
      "no intent",
      {
        text: "Researcher found the budget yesterday",
        quote: "Researcher found the budget",
      },
      "awaiting_approval",
    ],
    // An intent for a different member.
    [
      "other member",
      { text: said("Writer"), quote: quoted("Writer") },
      "awaiting_approval",
    ],
  ];
  for (const [label, options, phase] of cases)
    assert.equal(f.ask(f.temporary, options).phase, phase, label);
});

test("a quote from an earlier owner turn proves nothing in a later one", (t) => {
  const f = setup(t);
  f.turn(f.own.chat, said("Researcher"));
  const later = f.ask(f.temporary, {
    text: "Thanks, that is all",
    quote: quoted("Researcher"),
  });
  assert.equal(later.phase, "awaiting_approval");
});

test("one quote authorises one request, and a turn at most three", (t) => {
  const f = setup(t);
  const text =
    "Please ask Researcher about the budget, ask Researcher about the dates, ask Researcher about the team and ask Researcher about the risks";
  const attempt = f.turn(f.own.chat, text);
  const at = (quote) => f.ask(f.temporary, { attempt, quote }).phase;
  assert.equal(at("ask Researcher about the budget"), "queued");
  assert.equal(at("ask Researcher about the budget"), "awaiting_approval", "consumed");
  assert.equal(at("ask Researcher about the dates"), "queued");
  assert.equal(at("ask Researcher about the team"), "queued");
  assert.equal(at("ask Researcher about the risks"), "awaiting_approval", "cap");
});

test("requests per turn and per minute are capped", (t) => {
  const f = setup(t, { caps: { perMinute: 6, perTurn: 8 } });
  const attempt = f.turn(f.own.chat, said("Researcher"));
  for (let n = 0; n < 6; n++) f.ask(f.temporary, { attempt, claim: false });
  assert.throws(() => f.ask(f.temporary, { attempt, claim: false }), {
    status: 429,
    key: "memberRequestRate",
  });
  // Another lead has its own budget.
  const other = f.turn(f.other.chat, said("Scout"));
  assert.equal(f.ask(f.foreign, { attempt: other }).phase, "queued");
});

test("standing team permission does not skip a member request's approval", (t) => {
  const f = setup(t);
  f.teams.savePolicy(f.own.assistant.id, { autonomous: true }, 1);
  const task = f.ask(f.permanent, { claim: false, type: "task" });
  assert.equal(task.phase, "awaiting_approval");
  assert.equal(task.writeAllowed, false);
});

test("members cannot ask or delegate further and never get the tools", (t) => {
  const f = setup(t);
  const member = f.store.getAssistant(f.permanent.assistantId);
  const chat = f.store.getConversation(f.permanent.conversationId);
  assert.equal(member.lifetime, "permanent");
  const attempt = f.turn(chat, said("Researcher"));
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
  const tools = profileTools(member, true, true);
  for (const name of ["members", "ask", "delegate", "cancel", "archive", "propose"])
    assert.ok(!tools.includes(`agentpier_team_${name}`), name);
  // The positive control: the lead itself gets them.
  assert.ok(profileTools(f.own.assistant, true, true).includes("agentpier_team_ask"));
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
  const attempt = f.turn(f.own.chat, said("Researcher"));
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
  const r = f.ask(f.permanent, { context: origin, claim: false, type: "task" });
  assert.equal(r.phase, "awaiting_approval");
  const decide = (owner, request = r) =>
    f.requests.decide(
      request.id,
      { revision: request.revision, decision: "approve" },
      owner,
    );
  assert.throws(() => decide({ kind: "model" }), { status: 403 });
  assert.throws(() => decide({ ...origin, chatId: "2" }), { status: 403 });
  assert.throws(() => decide({ ...origin, channelId: "other" }), { status: 403 });
  const approved = decide(origin);
  assert.equal(approved.phase, "queued");
  assert.equal(approved.writeAllowed, true, "an approved task may write");
  assert.throws(() => decide(origin), { status: 409 });
  const later = f.ask(f.temporary, { claim: false });
  f.archive(f.teams.member(f.temporary.id));
  assert.throws(() => decide({ kind: "owner" }, later), { status: 404 });
  const declined = f.requests.decide(
    later.id,
    { revision: later.revision, decision: "decline" },
    { kind: "owner" },
  );
  assert.equal(declined.phase, "declined");
  assert.equal(declined.writeAllowed, false);
});

test("a lead archives only its own finished temporary members", (t) => {
  const f = setup(t);
  assert.equal(f.requests.archivable(f.own.assistant.id, [f.temporary.id]).length, 1);
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [f.permanent.id]), {
    status: 409,
  });
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [f.foreign.id]), {
    status: 404,
  });
  f.teams.write(f.teams.member(f.third.id), { phase: "running" });
  assert.throws(() => f.requests.archivable(f.own.assistant.id, [f.third.id]), {
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

test("the archive re-checks its conditions inside the archiving transaction", (t) => {
  const f = setup(t);
  const [member] = f.requests.archivable(f.own.assistant.id, [f.temporary.id]);
  // Asked after the check: the archive must not go through.
  f.ask(f.temporary);
  assert.throws(
    () =>
      f.teams.archive(member.id, member.revision, () =>
        f.requests.assertArchivable(f.own.assistant.id, member.id),
      ),
    { status: 409 },
  );
  assert.equal(f.teams.member(member.id).archivedAt, null);
});

test("finished requests are pruned per lead; open and undelivered ones stay", (t) => {
  const f = setup(t);
  const attempt = f.turn(f.own.chat, said("Researcher"));
  const made = Array.from({ length: 3 }, () =>
    f.ask(f.temporary, { attempt, claim: false }),
  );
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  f.teams.write(f.teams.get(made[0].id), {
    phase: "declined",
    settled: true,
    finishedAt: old,
  });
  f.teams.write(f.teams.get(made[1].id), { phase: "completed", finishedAt: old });
  assert.equal(f.requests.prune(), 1);
  assert.deepEqual(
    f.requests.list(f.own.assistant.id).map((r) => r.id),
    [made[1].id, made[2].id],
  );
  assert.deepEqual(
    f.requests.pending().map((r) => r.id),
    [made[1].id, made[2].id],
  );
});

test("an owner quote needs three words found in the owner's text", () => {
  assert.equal(ownerQuote("ask the  Researcher", "Please ask the researcher now"), true);
  assert.equal(ownerQuote("ask researcher", "Please ask researcher now"), false);
  assert.equal(ownerQuote("ask the boss", "Please ask the researcher now"), false);
  assert.equal(ownerQuote("x ".repeat(200), "x ".repeat(400)), false);
});
