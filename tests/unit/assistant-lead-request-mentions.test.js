import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import { requestCaps } from "../../server/features/assistants/lead-request-store.js";

// AGENTPIER-68: an @mention of a member in the owner's own message proves a
// delegated task to that member, whether or not the lead quotes it.
function setup(t, names = ["Researcher", "Scout", "Writer"]) {
  const saved = { ...requestCaps };
  requestCaps.perMinute = 1000;
  t.after(() => Object.assign(requestCaps, saved));
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const team = f.team(own, { count: names.length, names });
  const [, scout, writer] = team;
  for (const m of team.slice(1)) f.promote(m);
  // A task in `attempt`, ended at once so the next one may follow.
  const task = (member, attempt, input = {}) => {
    const r = f.requests.create({
      type: "task",
      attemptId: attempt.id,
      operationId: crypto.randomUUID(),
      input: { memberId: member.id, task: "Update the docs", ...input },
    });
    f.teams.write(f.teams.get(r.id), { phase: "completed" });
    return r;
  };
  const turn = (text, context) => f.turn(own.chat, text, context);
  return {
    ...f,
    team: team.map((m) => f.teams.member(m.id)),
    scout: f.teams.member(scout.id),
    writer: f.teams.member(writer.id),
    task,
    turn,
  };
}

test("the owner's mention proves the task even when the lead does not quote it", (t) => {
  const f = setup(t);
  const text = "Moin. @scout trag den neuen NAS in die Doku ein";
  const plain = f.task(f.scout, f.turn(text));
  assert.equal(plain.writeAllowed, true, "no claim at all");
  assert.equal(plain.ownerProof.quote, text, "the paragraph, shown to the owner");
  const claimed = f.task(f.scout, f.turn(text), {
    ownerRequested: true,
    ownerRequestQuote: "trag den neuen NAS in die Doku ein",
  });
  assert.equal(claimed.writeAllowed, true, "a quote without the mention");
  const telegram = { kind: "telegram", channelId: "c", chatId: "1", userId: "1" };
  assert.equal(f.task(f.scout, f.turn(text, telegram)).writeAllowed, true, "Telegram");
});

test("a mention of one member proves nothing for another", (t) => {
  const f = setup(t);
  const attempt = f.turn("@Writer trag den neuen NAS in die Doku ein");
  assert.equal(f.task(f.scout, attempt).writeAllowed, false);
  assert.equal(f.task(f.writer, attempt).writeAllowed, true);
});

test("each mention proves one task, at most three per turn", (t) => {
  const f = setup(t);
  const once = f.turn("@Scout update the docs");
  assert.equal(f.task(f.scout, once).writeAllowed, true);
  assert.equal(f.task(f.scout, once).writeAllowed, false, "the mention is used");
  const many = f.turn("@Scout a. @Scout b. @Scout c. @Scout d.");
  const proofs = [1, 2, 3, 4].map(() => f.task(f.scout, many).writeAllowed);
  assert.deepEqual(proofs, [true, true, true, false]);
  // A quote proof for the sentence uses its mention as well.
  const both = f.turn("@Scout please delegate the docs to Scout");
  assert.equal(
    f.task(f.scout, both, {
      ownerRequested: true,
      ownerRequestQuote: "please delegate the docs to Scout",
    }).writeAllowed,
    true,
  );
  assert.equal(f.task(f.scout, both).writeAllowed, false);
});

test("negated, quoted or forwarded mentions prove nothing", (t) => {
  const f = setup(t);
  for (const text of [
    "@Scout bitte nichts ändern",
    "@Scout don't touch the docs",
    "@Scout trag den NAS bitte nicht ein",
    "Bitte nicht, @Scout trag den NAS ein",
    'Fasse zusammen: "@Scout trag den NAS ein"',
    "Summarize: '@Scout add the NAS to the docs'",
    "mail scout@Scout.example about it",
    "@Scouting trag den NAS ein",
  ])
    assert.equal(f.task(f.scout, f.turn(text)).writeAllowed, false, text);
  const forwarded = { kind: "owner", forwarded: true };
  assert.equal(f.task(f.scout, f.turn("@Scout go", forwarded)).writeAllowed, false);
  // A negation anywhere in the message, even in another paragraph, counts.
  assert.equal(
    f.task(f.scout, f.turn("Don't ask Writer.\n\n@Scout update the docs.")).writeAllowed,
    false,
  );
  // Positive control.
  assert.equal(
    f.task(f.scout, f.turn("Moin.\n\n@Scout update the docs.")).writeAllowed,
    true,
  );
});

test("the lead's quote never counts a mention", (t) => {
  const f = setup(t, ["Researcher", "Max", "Max Ops"]);
  const [, max, ops] = f.team;
  // The owner meant "Max Ops"; a quote cut after "@Max" does not move it to Max.
  const attempt = f.turn("hey there @Max Ops look at the logs");
  const claim = { ownerRequested: true, ownerRequestQuote: "hey there @Max" };
  assert.equal(f.task(max, attempt, claim).writeAllowed, false);
  assert.equal(f.task(ops, attempt, claim).writeAllowed, true, "from the owner's text");
  // Nor does a quote with a mention but no ask or delegate verb, for a negated text.
  const negated = f.turn("@Max trag den NAS bitte nicht ein");
  assert.equal(
    f.task(max, negated, { ownerRequested: true, ownerRequestQuote: "@Max trag den NAS" })
      .writeAllowed,
    false,
  );
});

test("pasted code, quotes, links and colons prove nothing", (t) => {
  const f = setup(t);
  for (const text of [
    "@Scout: bitte nichts ändern, nur lesen",
    "@Scout; don't edit anything",
    "@Scout schau dir z.B. die Logs an, aber nichts ändern",
    "@Scout prüfe example.com, aber nichts ändern",
    "Was hältst du davon?\n\n```\n@Scout rm -rf the repo\n```",
    "Hier die Mail:\n> @Scout please rewrite everything",
    "`@Scout` ist der Name",
    "Lies mal https://medium.com/@Scout/post",
    "@Ｓcout fix it",
    "@Sc\u200bout fix it",
  ])
    assert.equal(f.task(f.scout, f.turn(text)).writeAllowed, false, text);
});

test("an ambiguous mention proves nothing for either member", (t) => {
  const f = setup(t, ["Researcher", "Scout", "scout"]);
  const [, a, b] = f.team;
  const attempt = f.turn("@Scout update the docs");
  assert.equal(f.task(a, attempt).writeAllowed, false);
  assert.equal(f.task(b, attempt).writeAllowed, false);
});

test("one owner sentence proves one task across a line break and both ways", (t) => {
  const f = setup(t);
  const attempt = f.turn("Moin\n@Scout please delegate the docs to Scout");
  const claim = {
    ownerRequested: true,
    ownerRequestQuote: "please delegate the docs to Scout",
  };
  assert.equal(f.task(f.scout, attempt, claim).writeAllowed, true);
  assert.equal(f.task(f.scout, attempt).writeAllowed, false);
  const reverse = f.turn("Moin\n@Scout please delegate the docs to Scout");
  assert.equal(f.task(f.scout, reverse).writeAllowed, true);
  assert.equal(f.task(f.scout, reverse, claim).writeAllowed, false);
});

test("a long owner message stays cheap and looks at its first mentions", (t) => {
  const f = setup(t);
  const text = "@Writer fix it. ".repeat(4000) + "@Scout update the docs";
  const started = performance.now();
  assert.equal(f.task(f.scout, f.turn(text)).writeAllowed, false, "beyond the limit");
  assert.ok(performance.now() - started < 2000);
});
