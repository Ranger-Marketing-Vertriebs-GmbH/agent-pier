import test from "node:test";
import assert from "node:assert/strict";
import { writeGate } from "../helpers/lead-request-service-fixture.js";
import { autonomousCaps } from "../../server/features/assistants/team-policy.js";

// The owner's team usage level for the fixture's lead.
const level = (f, usage) => {
  const policy = f.service.store.policy(f.parent.id);
  f.service.store.savePolicy(f.parent.id, { usage }, policy.revision);
};
// A task the lead starts on its own, without any owner claim.
const own = (f, inv) =>
  f.service.delegate(inv, { memberId: f.permanent.id, task: "Draft the plan" });
const finish = (f, requestId) => {
  const r = f.service.requests.store.get(requestId);
  f.complete(r.attemptId);
};

test("a lead's own task writes in the member's workspace only when autonomous", async (t) => {
  for (const usage of ["onRequest", "suggest", "autonomous"]) {
    await t.test(usage, async (t) => {
      const f = await writeGate(t);
      level(f, usage);
      const result = await own(f, f.turn("Plan the release for next week"));
      assert.equal(result.mayWrite, usage === "autonomous");
      assert.equal(!!result.selfInitiated, usage === "autonomous");
      // The member's own run: a workspace file, never its memory.
      assert.equal(f.write(), usage === "autonomous", "workspace write");
      assert.equal(f.write("memory/today.md"), false, "memory stays read-only");
      assert.equal(f.write("MEMORY.md"), false);
      finish(f, result.requestId);
      await f.service.reconcile();
    });
  }
});

test("an owner's negation keeps an autonomous task read-only", async (t) => {
  const f = await writeGate(t);
  level(f, "autonomous");
  const result = await own(
    f,
    f.turn(`Ask ${f.member.name} to review the plan, but don't change anything`),
  );
  assert.equal(result.mayWrite, false);
  assert.equal(f.write(), false);
});

test("autonomy never widens forwarded or scheduled turns", async (t) => {
  const f = await writeGate(t);
  level(f, "autonomous");
  for (const context of [{ kind: "owner", forwarded: true }, { kind: "routine" }]) {
    const result = await own(f, f.turn("Plan the release", context));
    assert.equal(result.mayWrite, false, context.kind);
    assert.equal(result.selfInitiated, true);
    assert.equal(f.write(), false);
    finish(f, result.requestId);
    await f.service.reconcile();
  }
});

// The lead's last reply in its chat, as the Gateway's history serves it.
const lastReply = (f, text) => {
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ id: "r1", role: "assistant", text, runId: "earlier-run" }],
  });
};

test("under suggest the owner's yes after the offer lets the task write", async (t) => {
  const f = await writeGate(t);
  level(f, "suggest");
  lastReply(f, `Should I ask ${f.member.name} to draft the plan?`);
  const yes = await own(f, f.turn("Yes, go ahead"));
  assert.equal(yes.mayWrite, false, "without the quote the yes proves nothing");
  finish(f, yes.requestId);
  await f.service.reconcile();
  const quoted = await f.delegate(f.turn("Yes, go ahead"), {
    ownerRequestQuote: "Yes, go ahead",
  });
  assert.equal(quoted.mayWrite, true);
  assert.equal(f.write(), true);
  const card = f.service.requests.list(f.parent.id).at(-1);
  assert.equal(card.ownerRequestQuote, "Yes, go ahead");
  assert.equal(card.selfInitiated, undefined);
  // A yes to an offer of something else proves nothing.
  finish(f, quoted.requestId);
  await f.service.reconcile();
  lastReply(f, "Shall I summarize the mail?");
  const other = await f.delegate(f.turn("ok"), { ownerRequestQuote: "ok" });
  assert.equal(other.mayWrite, false);
  // Under "on request" the same yes stays read-only.
  finish(f, other.requestId);
  await f.service.reconcile();
  lastReply(f, `Should I ask ${f.member.name} to draft the plan?`);
  level(f, "onRequest");
  const strict = await f.delegate(f.turn("Yes, go ahead"), {
    ownerRequestQuote: "Yes, go ahead",
  });
  assert.equal(strict.mayWrite, false);
});

test("the autonomous budget refuses with a clear tool error", async (t) => {
  const f = await writeGate(t);
  level(f, "autonomous");
  f.service.requests.waitMs = 0;
  const inv = f.turn("What do we know about the market?");
  for (let n = 0; n < autonomousCaps.perTurn; n++)
    await f.service.ask(
      { ...inv, toolCallId: crypto.randomUUID() },
      { memberId: f.temporary.id, question: `Question ${n}` },
    );
  await assert.rejects(
    f.service.ask(
      { ...inv, toolCallId: crypto.randomUUID() },
      { memberId: f.temporary.id, question: "One more" },
    ),
    { status: 429, key: "memberRequestAutonomousLimit" },
  );
});

test("the lead's roster names its members and the level", async (t) => {
  const f = await writeGate(t);
  assert.equal(f.service.requests.roster(f.parent.id).usage, "suggest");
  level(f, "autonomous");
  const roster = f.service.requests.roster(f.parent.id);
  assert.equal(roster.usage, "autonomous");
  assert.deepEqual(
    roster.members.map((m) => [m.lifetime, typeof m.name, "busy" in m]),
    [
      ["task", "string", false],
      ["permanent", "string", false],
    ],
  );
});
