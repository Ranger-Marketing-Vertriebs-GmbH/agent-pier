import test from "node:test";
import assert from "node:assert/strict";
import { leadStoreFixture } from "../helpers/lead-request-fixture.js";
import { requestCaps } from "../../server/features/assistants/lead-request-store.js";

// AGENTPIER-68: an @mention of a member in the owner's own message proves a
// delegated task to that member, whether or not the lead quotes it.
function setup(t) {
  const saved = { ...requestCaps };
  requestCaps.perMinute = 1000;
  t.after(() => Object.assign(requestCaps, saved));
  const f = leadStoreFixture(t);
  const own = f.lead("Lead");
  const [, scout, writer] = f.team(own, {
    count: 3,
    names: ["Researcher", "Scout", "Writer"],
  });
  f.promote(scout);
  f.promote(writer);
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
  assert.equal(plain.ownerProof.quote, "@scout trag den neuen NAS in die Doku ein");
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
  // A later affirmative sentence still counts.
  assert.equal(
    f.task(f.scout, f.turn("Don't ask Writer. @Scout update the docs.")).writeAllowed,
    true,
  );
});
